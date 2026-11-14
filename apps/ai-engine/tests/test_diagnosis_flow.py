import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fakes import Scripted
from test_investigation import VIEW, FakeApi, world

from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest, ToolResult
from ai_engine.answer.tools import ToolError
from ai_engine.llm import LlmRequest

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
RID = "11111111-2222-4333-8444-555555555555"

PLAN = {
    "outcome": "plan",
    "plan": {
        "intent": "diagnostic",
        "measures": ["revenue"],
        "time_range": {"relative": "last_month"},
        "comparison": {"type": "previous_period"},
    },
}


class Api:
    """The api as the flow sees it: one scripted world behind execute_plan."""

    def __init__(self, fake: FakeApi | None = None, fail: str | None = None) -> None:
        self.fake = fake or FakeApi(world())
        self.fail = fail
        self.calls = 0

    def execute_plan(
        self, request_context: str, request_id: str, plan: dict[str, Any]
    ) -> ToolResult:
        self.calls += 1
        if self.fail:
            raise ToolError(self.fail)  # type: ignore[arg-type]
        return self.fake(plan)


def request(question: str = "Why did revenue drop in October?") -> AnswerRequest:
    return AnswerRequest.model_validate(
        {
            "request_context": "signed.token",
            "question": question,
            "authorized_view": VIEW.model_dump(),
            "resolved_now": NOW.isoformat(),
        }
    )


def payload(req: LlmRequest) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(req.prompt.split("<data>")[1].split("</data>")[0])
    return loaded


def good_explainer(req: LlmRequest) -> dict[str, Any]:
    p = payload(req)
    top = p["result_sets"][0]["rows"][0]
    pct = next(d["ref"] for d in p["derived"] if d["label"].startswith("Percent"))
    return {
        "summary": f"Revenue changed by {{{{{pct}}}}}, mostly in {top['where']}.",
        "verified_facts": [
            {
                "statement": f"{top['where']}: {{{{{top['change']['ref']}}}}}, "
                f"{{{{{top['share_of_change']['ref']}}}}} of the change",
                "result_set_id": "findings",
            }
        ],
        "possible_explanations": [{"text": "Stock-outs or a lost contract could explain this."}],
        "unknowns": [],
    }


def test_a_why_question_is_investigated_and_explained_from_the_ledger() -> None:
    api = Api()
    model = Scripted(PLAN, good_explainer)
    r = answer_question(request(), RID, model, api)
    assert r.status == "answered" and r.execution["grounding"] == "passed"
    assert r.summary == "Revenue changed by -16.7%, mostly in Branch: Nashik."
    assert 1 < r.execution["tool_calls"] <= 6
    assert r.execution["tool_calls"] == api.calls
    # the planner and the explainer were each called once: the investigation chose its own steps
    assert [q.role for q in model.requests] == ["planner", "explainer"]
    assert (
        r.execution["usage"]["planner"]["calls"] == 1
        and r.execution["usage"]["explainer"]["calls"] == 1
    )
    fact = r.verified_facts[0]["statement"]
    assert fact.startswith("Branch: Nashik:") and "of the change" in fact

    # the findings table is display text only, in order of contribution, with the second level inside
    table = r.tables[0]
    assert [c["label"] for c in table["columns"]] == [
        "Where",
        "Previous",
        "Current",
        "Change",
        "Share of change",
    ]
    wheres = [row[0] for row in table["rows"]]
    assert wheres[0] == "Branch: Nashik" and any(
        w.startswith("Nashik › ") and "Snacks" in w for w in wheres
    )
    assert table["rows"][0][4] == "100.0%"
    ids = {e["id"] for e in r.evidence}
    assert all(i in ids for row in table["cell_evidence"] for i in row if i)
    assert table["cell_evidence"][0][0] is None and all(table["cell_evidence"][0][1:])

    # every number has a record, and every derived record names inputs that exist
    by_id = {e["id"]: e for e in r.evidence}
    kinds = {e["derived"]["formula_id"] for e in r.evidence if e["kind"] == "derived"}
    assert {"abs_change", "pct_change", "contribution_to_delta", "sum_of_changes"} <= kinds
    for e in r.evidence:
        if e["kind"] == "derived":
            assert all(i in by_id for i in e["derived"]["input_ids"])
    # product figures come from line revenue and the answer says they are approximate
    assert any("line revenue" in u for u in r.unknowns)
    assert r.possible_explanations[0]["text"].startswith("Stock-outs")


def test_the_explainer_sees_evidence_ids_and_never_raw_amounts() -> None:
    model = Scripted(PLAN, good_explainer)
    answer_question(request(), RID, model, Api())
    prompt = model.requests[1].prompt
    assert "ev_" in prompt and "50000" not in prompt and "100000" not in prompt


def test_untrustworthy_text_degrades_to_findings_written_by_code() -> None:
    bad = {"summary": "Revenue fell 22 percent", "verified_facts": [], "unknowns": []}
    r = answer_question(request(), RID, Scripted(PLAN, bad, bad), Api())
    assert r.status == "answered_facts_only" and r.execution["grounding"] == "failed_degraded"
    assert r.verified_facts[0]["statement"].startswith("Branch: Nashik: ")
    assert "of the change" in r.verified_facts[0]["statement"]
    assert r.tables  # the findings table is still shown


def test_no_change_is_answered_by_code_without_the_explainer() -> None:
    model = Scripted(PLAN)
    r = answer_question(request(), RID, model, Api(FakeApi(world(snack_drop=0))))
    assert r.status == "answered" and "did not change" in r.summary
    assert len(model.requests) == 1 and r.execution["tool_calls"] == 1


def test_a_refused_first_step_is_not_authorized_and_never_explained() -> None:
    model = Scripted(PLAN)
    r = answer_question(request(), RID, model, Api(fail="not_authorized"))
    assert r.status == "not_authorized" and len(model.requests) == 1
    assert r.verified_facts == [] and r.evidence == []


def test_a_why_question_without_a_comparison_is_a_plain_answer() -> None:
    plain = {
        "outcome": "plan",
        "plan": {
            "intent": "diagnostic",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    api = Api()
    answer_question(
        request(), RID, Scripted(plain, {"summary": "x", "verified_facts": [], "unknowns": []}), api
    )
    assert api.calls == 1  # one ordinary query, no investigation


def test_the_investigation_collects_sources_from_every_step_without_repeats() -> None:
    fake = FakeApi(world())
    src = {"data_source_id": "s1", "data_source_name": "Tally export", "entity": "invoice"}

    class WithSources(Api):
        def execute_plan(
            self, request_context: str, request_id: str, plan: dict[str, Any]
        ) -> ToolResult:
            r = super().execute_plan(request_context, request_id, plan)
            r.sources = [src]
            return r

    r = answer_question(request(), RID, Scripted(PLAN, good_explainer), WithSources(fake))
    assert r.sources == [src]
