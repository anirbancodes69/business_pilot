import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from fakes import FakeTools, Scripted, data_refs, tool_result
from fastapi.testclient import TestClient
from test_planner import GOOD, VIEW

from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest
from ai_engine.answer.tools import ApiTools, ToolError
from ai_engine.llm import LlmRequest
from ai_engine.main import create_app
from ai_engine.settings import Settings

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
RID = "11111111-2222-4333-8444-555555555555"


def request(question: str = "Which customers have the highest dues?") -> AnswerRequest:
    return AnswerRequest.model_validate(
        {
            "request_context": "signed.token",
            "question": question,
            "authorized_view": VIEW.model_dump(),
            "resolved_now": NOW.isoformat(),
        }
    )


def good_explainer(req: LlmRequest) -> dict[str, Any]:
    rows = data_refs(req)[0]["rows"]
    top = rows[0]["outstanding_receivables"]["ref"]
    return {
        "summary": f"{rows[0]['customer.name']} owes the most, {{{{{top}}}}}.",
        "verified_facts": [
            {"statement": f"Top: {{{{{top}}}}}", "result_set_id": data_refs(req)[0]["id"]}
        ],
        "possible_explanations": [{"text": "Payment terms may differ between customers."}],
        "unknowns": ["Credit limits are not in this data."],
    }


ROWS = [["Asha Traders", "900000.00"], ["Vikram Stores", "50000.00"]]


def test_happy_path_renders_numbers_from_the_ledger_only() -> None:
    model = Scripted(GOOD, good_explainer)
    tools = FakeTools(tool_result(ROWS))
    r = answer_question(request(), RID, model, tools)
    assert r.status == "answered"
    assert r.summary == "Asha Traders owes the most, ₹9.00 lakh."
    assert r.verified_facts[0]["statement"] == "Top: ₹9.00 lakh"
    assert r.execution["grounding"] == "passed" and r.execution["tool_calls"] == 1
    assert r.execution["prompt_versions"] == {"planner": "planner-v2", "explainer": "explainer-v1"}
    # one planner call and one explainer call, and the api saw an absolute-dated plan
    assert [q.role for q in model.requests] == ["planner", "explainer"]
    assert tools.calls[0]["plan"]["time_range"]["start"] == "2026-04-01"
    assert (
        tools.calls[0]["request_context"] == "signed.token" and tools.calls[0]["request_id"] == RID
    )
    # every cited evidence id exists in the ledger, and the context holds ids only
    ids = {e["id"] for e in r.evidence}
    assert all(i in ids for f in r.verified_facts for i in f["evidence_ids"])
    ctx = r.analytical_context or {}
    assert ctx["turn"] == 1 and ctx["focus"]["metrics"] == ["outstanding_receivables"]
    assert "900000" not in json.dumps(ctx) and "Asha" not in json.dumps(ctx)


def test_the_explainer_never_sees_raw_numbers() -> None:
    model = Scripted(GOOD, good_explainer)
    answer_question(request(), RID, model, FakeTools(tool_result(ROWS)))
    prompt = model.requests[1].prompt
    assert "900000" not in prompt and "₹9.00 lakh" in prompt and "ev_" in prompt


def test_literal_digits_cause_one_regeneration() -> None:
    bad = {"summary": "Asha owes 9 lakh", "verified_facts": [], "unknowns": []}
    model = Scripted(GOOD, bad, good_explainer)
    r = answer_question(request(), RID, model, FakeTools(tool_result(ROWS)))
    assert r.status == "answered" and r.execution["grounding"] == "passed_after_regeneration"
    assert "literal number in text" in model.requests[2].prompt


def test_untrustworthy_text_degrades_to_facts_written_by_code() -> None:
    bad = {"summary": "Asha owes 9 lakh", "verified_facts": [], "unknowns": []}
    model = Scripted(GOOD, bad, bad)
    r = answer_question(request(), RID, model, FakeTools(tool_result(ROWS)))
    assert r.status == "answered_facts_only" and r.execution["grounding"] == "failed_degraded"
    assert [f["statement"] for f in r.verified_facts] == [
        "Asha Traders: ₹9.00 lakh",
        "Vikram Stores: ₹50,000",
    ]
    assert len(model.requests) == 3  # planner, explainer, one regeneration; never more


def test_comparison_without_grouping_gets_derived_calculations() -> None:
    plan = {
        **GOOD["plan"],
        "intent": "comparison",
        "measures": ["revenue"],
        "dimensions": [],
        "sort": [],
        "comparison": {"type": "previous_period"},
        "time_range": {"relative": "last_month"},
    }
    plan.pop("limit")

    def explain(req: LlmRequest) -> dict[str, Any]:
        derived = json.loads(req.prompt.split("<data>")[1].split("</data>")[0])["derived"]
        pct = next(d["ref"] for d in derived if d["label"].startswith("Percent"))
        return {
            "summary": f"Revenue changed by {{{{{pct}}}}}.",
            "verified_facts": [],
            "unknowns": [],
        }

    tools = FakeTools(
        tool_result(
            [["1500.00"]], dimension=False, measure="revenue", comparison_rows=[["1200.00"]]
        )
    )
    r = answer_question(
        request("Revenue vs last month"), RID, Scripted({**GOOD, "plan": plan}, explain), tools
    )
    assert r.summary == "Revenue changed by 25.0%."
    assert {d["label"] for d in r.derived_calculations} == {
        "Change in Revenue",
        "Percent change in Revenue",
    }
    kinds = {e["kind"] for e in r.evidence}
    assert kinds == {"result", "derived"}


def test_not_authorized_and_failures_never_reach_the_explainer() -> None:
    for kind, status in (("not_authorized", "not_authorized"), ("timeout", "failed")):
        model = Scripted(GOOD)
        r = answer_question(request(), RID, model, FakeTools(kind))  # type: ignore[arg-type]
        assert r.status == status and len(model.requests) == 1
        assert r.verified_facts == [] and r.evidence == []


def test_no_matching_rows_is_answered_without_a_model_call() -> None:
    model = Scripted(GOOD)
    r = answer_question(request(), RID, model, FakeTools(tool_result([])))
    assert r.status == "answered" and len(model.requests) == 1
    assert r.unknowns == ["No rows matched the question and period."]


def test_clarification_and_out_of_scope_make_no_data_call() -> None:
    tools = FakeTools(tool_result(ROWS))
    c = answer_question(
        request(),
        RID,
        Scripted({"outcome": "clarify", "clarification_question": "Which period?"}),
        tools,
    )
    assert c.status == "clarification_needed" and c.clarification_question == "Which period?"
    o = answer_question(request(), RID, Scripted({"outcome": "out_of_scope"}), tools)
    assert o.status == "out_of_scope" and tools.calls == []


def test_response_fields_are_in_the_contract() -> None:
    from pathlib import Path

    from ai_engine.answer.models import AnswerResponse

    schema = json.loads(
        (Path(__file__).parents[3] / "contracts/ai/answer-response.schema.json").read_text()
    )
    assert set(AnswerResponse.model_fields) == set(schema["properties"])
    r = answer_question(
        request(), RID, Scripted(GOOD, good_explainer), FakeTools(tool_result(ROWS))
    )
    assert set(schema["required"]) <= set(r.model_dump(exclude_none=True))


def test_api_tool_client_maps_statuses_and_sends_credentials() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(
            auth=req.headers["authorization"],
            rid=req.headers["x-request-id"],
            body=json.loads(req.content),
        )
        code = seen.get("code", 200)
        return httpx.Response(code, json={"message": "tenant 1 secret"})

    for code, kind in (
        (403, "not_authorized"),
        (422, "invalid_plan"),
        (429, "rate_limited"),
        (504, "timeout"),
        (500, "failed"),
    ):
        seen["code"] = code
        tools = ApiTools(
            "http://api", "tok-0123456789abcdef", transport=httpx.MockTransport(handler)
        )
        with pytest.raises(ToolError) as e:
            tools.execute_plan("ctx", RID, {"a": 1})
        assert e.value.kind == kind
    assert seen["auth"] == "Bearer tok-0123456789abcdef" and seen["rid"] == RID
    assert seen["body"] == {"request_context": "ctx", "plan": {"a": 1}}


def _client(token: str | None) -> TestClient:
    app = create_app(
        Settings(otel_traces_exporter="none", internal_service_token=token),
        llm=Scripted(GOOD, good_explainer),
        tools=FakeTools(tool_result(ROWS)),
    )
    return TestClient(app)


def _body() -> dict[str, Any]:
    return {
        "request_context": "signed.token",
        "question": "dues?",
        "authorized_view": VIEW.model_dump(),
        "resolved_now": NOW.isoformat(),
    }


def test_the_answer_endpoint_needs_the_service_token_and_fails_closed() -> None:
    token = "service-token-0123456789"
    ok = _client(token).post(
        "/internal/v1/answer", json=_body(), headers={"authorization": f"Bearer {token}"}
    )
    assert ok.status_code == 200 and ok.json()["status"] == "answered"
    assert _client(token).post("/internal/v1/answer", json=_body()).status_code == 401
    wrong = {"authorization": "Bearer nope"}
    assert (
        _client(token).post("/internal/v1/answer", json=_body(), headers=wrong).status_code == 401
    )
    # no configured token: nobody gets in, even with an empty header
    assert _client(None).post("/internal/v1/answer", json=_body()).status_code == 401
    assert (
        _client(None)
        .post("/internal/v1/answer", json=_body(), headers={"authorization": "Bearer "})
        .status_code
        == 401
    )
