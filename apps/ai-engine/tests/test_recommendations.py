import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fakes import FakeTools, Scripted, tool_result
from test_diagnosis_flow import Api

from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest
from ai_engine.answer.tools import ToolError
from ai_engine.llm import LlmRequest
from ai_engine.planning.view import AuthorizedView
from ai_engine.recommendations.playbooks import (
    Recommendation,
    for_comparison,
    for_customer_ranking,
    needs_total,
    recommend,
)

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
RID = "11111111-2222-4333-8444-555555555555"

VIEW = AuthorizedView.model_validate(
    {
        "semantic_model_version": 1,
        "tenant_settings": {},
        "measures": [
            {
                "id": "revenue",
                "entity": "invoice",
                "label": "Revenue",
                "unit": "currency",
                "polarity": "higher_is_better",
                "additivity": "additive",
                "default_time_dimension": "invoice.invoice_date",
            },
            {
                "id": "outstanding_receivables",
                "entity": "invoice",
                "label": "Outstanding receivables",
                "unit": "currency",
                "polarity": "lower_is_better",
                "additivity": "semi_additive",
                "default_time_dimension": "invoice.invoice_date",
            },
            {
                "id": "units",
                "entity": "invoice_line",
                "label": "Units sold",
                "unit": "quantity",
                "polarity": "neutral",
                "additivity": "additive",
                "default_time_dimension": "invoice.invoice_date",
            },
        ],
        "dimensions": [
            {"id": "customer.name", "label": "Customer", "type": "categorical"},
            {"id": "branch.name", "label": "Branch", "type": "categorical"},
            {"id": "invoice.invoice_date", "label": "Invoice date", "type": "time"},
        ],
    }
)


def derived_pct(value: float, name: str) -> tuple[str, Evidence]:
    ledger = EvidenceLedger()
    cur = ledger.add_result(
        "100", "currency", ResultRef(result_set_id="a", column="c", row=0, plan_hash="h")
    )
    prev = ledger.add_result(
        str(100 / (1 + value / 100)),
        "currency",
        ResultRef(result_set_id="b", column="c", row=0, plan_hash="h"),
    )
    from ai_engine.analysis.calculations import pct_change

    ev = pct_change(ledger, cur, prev)
    assert ev is not None
    return f"Percent change in {name}", ev


def test_a_material_drop_in_a_good_figure_suggests_asking_why() -> None:
    recs = for_comparison(VIEW, [derived_pct(-22.2, "Revenue")])
    assert [r.playbook_id for r in recs] == ["material_decline_investigate"]
    assert "-22.2%" in recs[0].text and "Why did revenue drop?" in recs[0].text
    assert recs[0].evidence_ids  # cites the percent change


def test_small_moves_good_news_and_unjudged_measures_produce_nothing() -> None:
    assert for_comparison(VIEW, [derived_pct(-5, "Revenue")]) == []
    assert for_comparison(VIEW, [derived_pct(30, "Revenue")]) == []  # up is good: no concern
    assert for_comparison(VIEW, [derived_pct(-40, "Units sold")]) == []  # neutral polarity
    assert for_comparison(VIEW, [derived_pct(-40, "Unknown measure")]) == []


def test_a_rise_in_money_owed_suggests_a_review() -> None:
    recs = for_comparison(VIEW, [derived_pct(25, "Outstanding receivables")])
    assert [r.playbook_id for r in recs] == ["material_increase_review"]
    assert for_comparison(VIEW, [derived_pct(5, "Outstanding receivables")]) == []


PLAN = {"measures": ["outstanding_receivables"], "dimensions": [{"id": "customer.name"}]}


def ranking(values: list[int], truncated: bool = False) -> Any:
    rows = [[f"Customer {chr(65 + i)}", f"{v}.00"] for i, v in enumerate(values)]
    result = tool_result(rows, measure="outstanding_receivables")
    result.result_sets[0].truncated = truncated
    return result


def test_money_held_by_a_few_customers_suggests_prioritising_them() -> None:
    ledger = EvidenceLedger()
    recs = for_customer_ranking(VIEW, PLAN, ranking([500, 300, 200, 50, 40, 10]), ledger)
    assert [r.playbook_id for r in recs] == ["receivables_concentration"]
    assert (
        "Customer A, Customer B, Customer C hold 90.9% of the outstanding receivables"
        in recs[0].text
    )
    ids = {e.id: e for e in ledger.items()}
    share = ids[recs[0].evidence_ids[0]]
    assert share.derived is not None and share.derived.formula_id == "share_of_total"
    formulas = {d.formula_id for i in share.derived.input_ids if (d := ids[i].derived) is not None}
    assert formulas == {"sum_of_values"}


def test_it_stays_silent_when_it_cannot_be_sure() -> None:
    spread = [100, 95, 90, 90, 85, 80, 75, 70]
    assert for_customer_ranking(VIEW, PLAN, ranking(spread), EvidenceLedger()) == []
    assert (
        for_customer_ranking(
            VIEW, PLAN, ranking([500, 300, 200, 50, 40, 10], truncated=True), EvidenceLedger()
        )
        == []
    )
    assert (
        for_customer_ranking(VIEW, PLAN, ranking([500, 300, 200, 50]), EvidenceLedger()) == []
    )  # too few rows
    branch = {"measures": PLAN["measures"], "dimensions": [{"id": "branch.name"}]}
    assert (
        for_customer_ranking(VIEW, branch, ranking([500, 300, 200, 50, 40, 10]), EvidenceLedger())
        == []
    )
    good = {"measures": ["revenue"], "dimensions": PLAN["dimensions"]}
    assert (
        for_customer_ranking(VIEW, good, ranking([500, 300, 200, 50, 40, 10]), EvidenceLedger())
        == []
    )


def test_a_recommendation_without_evidence_is_dropped_and_the_list_is_capped() -> None:
    items = [
        Recommendation("a", "p1", ()),
        Recommendation("b", "p2", ("ev_1",)),
        Recommendation("c", "p2", ("ev_2",)),  # same playbook twice
        Recommendation("d", "p3", ("ev_3",)),
        Recommendation("e", "p4", ("ev_4",)),
    ]
    assert [r.playbook_id for r in recommend(items)] == ["p2", "p3"]


def numbers_in(text: str) -> list[str]:
    return re.findall(r"\d[\d,.]*", text)


def assert_grounded(answer: Any) -> None:
    """Hard gate: every recommendation cites evidence that exists, and every number in its text is
    one that cited evidence (or its inputs) displays."""
    by_id = {e["id"]: e for e in answer.evidence}
    for r in answer.recommendations:
        assert r["evidence_ids"] and all(i in by_id for i in r["evidence_ids"])
        shown = " ".join(by_id[i]["display"] for i in r["evidence_ids"])
        for n in numbers_in(r["text"]):
            assert n in shown, (n, r["text"])


def request(question: str, view: AuthorizedView = VIEW) -> AnswerRequest:
    return AnswerRequest.model_validate(
        {
            "request_context": "signed.token",
            "question": question,
            "authorized_view": view.model_dump(),
            "resolved_now": NOW.isoformat(),
        }
    )


def test_a_ranking_answer_carries_a_grounded_recommendation() -> None:
    plan = {
        "outcome": "plan",
        "plan": {
            "intent": "ranking",
            "measures": ["outstanding_receivables"],
            "dimensions": [{"id": "customer.name"}],
            "time_range": {"relative": "last_n_days", "n": 730},
            "sort": [{"by": "outstanding_receivables", "direction": "desc"}],
        },
    }

    def explain(req: LlmRequest) -> dict[str, Any]:
        return {"summary": "x", "verified_facts": [], "unknowns": []}

    r = answer_question(
        request("Which customers owe the most?"),
        RID,
        Scripted(plan, explain),
        FakeTools(ranking([500, 300, 200, 50, 40, 10])),
    )
    assert [x["playbook_id"] for x in r.recommendations] == ["receivables_concentration"]
    assert_grounded(r)


def test_no_playbook_fires_for_an_ordinary_answer() -> None:
    plan = {
        "outcome": "plan",
        "plan": {
            "intent": "metric",
            "measures": ["revenue"],
            "time_range": {"relative": "last_month"},
        },
    }
    r = answer_question(
        request("Revenue last month?"),
        RID,
        Scripted(plan, {"summary": "x", "verified_facts": [], "unknowns": []}),
        FakeTools(tool_result([["100.00"]], dimension=False, measure="revenue")),
    )
    assert r.recommendations == []


def test_an_investigation_recommends_looking_at_the_dominant_part_first() -> None:
    from test_diagnosis_flow import PLAN as WHY
    from test_diagnosis_flow import good_explainer
    from test_investigation import VIEW as INV_VIEW

    inv_view = AuthorizedView.model_validate(
        {
            **INV_VIEW.model_dump(),
            "measures": [
                {**m, "polarity": "higher_is_better"}
                for m in (x.model_dump() for x in INV_VIEW.measures)
            ],
        }
    )
    r = answer_question(
        request("Why did revenue drop?", inv_view),
        RID,
        Scripted(WHY, good_explainer),
        Api(),
    )
    ids = [x["playbook_id"] for x in r.recommendations]
    assert ids == ["dominant_driver_review", "driver_second_level"]
    assert (
        "Branch: Nashik accounts for 100.0% of the decline. Review what happened there first."
        == r.recommendations[0]["text"]
    )
    assert (
        "Inside Nashik" in r.recommendations[1]["text"] and "Snacks" in r.recommendations[1]["text"]
    )
    assert_grounded(r)


def test_a_question_the_system_refuses_gets_no_recommendations() -> None:
    r = answer_question(
        request("Why did revenue drop?"),
        RID,
        Scripted({"outcome": "out_of_scope"}),
        FakeTools(tool_result([["1.00"]], dimension=False, measure="revenue")),
    )
    assert r.recommendations == []


def total_of(value: int) -> Any:
    t = tool_result([[f"{value}.00"]], dimension=False, measure="outstanding_receivables")
    t.plan_hash = "t" * 64  # a different query from the ranking, as in real life
    t.result_sets[0].id = "total-current"
    return t


def test_a_cut_short_ranking_asks_for_the_total_and_only_then() -> None:
    cut = ranking([500, 300, 200, 50, 40, 10], truncated=True)
    plan = needs_total(
        VIEW,
        {**PLAN, "limit": 10, "sort": [{"by": "outstanding_receivables", "direction": "desc"}]},
        cut,
    )
    assert plan is not None
    assert (
        "dimensions" not in plan
        and "limit" not in plan
        and "sort" not in plan
        and plan["intent"] == "metric"
    )
    assert needs_total(VIEW, PLAN, ranking([500, 300, 200, 50, 40, 10])) is None  # nothing was cut
    ascending = {**PLAN, "sort": [{"by": "outstanding_receivables", "direction": "asc"}]}
    assert needs_total(VIEW, ascending, cut) is None  # the visible rows are not the largest


def test_the_share_of_a_cut_short_ranking_uses_the_real_total() -> None:
    cut = ranking([500, 300, 200, 50, 40, 10], truncated=True)
    ledger = EvidenceLedger()
    recs = for_customer_ranking(VIEW, PLAN, cut, ledger, total_of(1200))
    assert recs and "83.3%" in recs[0].text
    assert for_customer_ranking(VIEW, PLAN, cut, EvidenceLedger(), total_of(5000)) == []  # 20%
    assert for_customer_ranking(VIEW, PLAN, cut, EvidenceLedger(), None) == []  # total unknown


class Sequence:
    """Tools that answer in order: the ranking first, then the total (or a refusal)."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.plans: list[dict[str, Any]] = []

    def execute_plan(self, request_context: str, request_id: str, plan: dict[str, Any]) -> Any:
        self.plans.append(plan)
        a = self.answers.pop(0)
        if isinstance(a, str):
            raise ToolError(a)  # type: ignore[arg-type]
        return a


def test_the_flow_fetches_the_total_once_and_the_recommendation_is_grounded() -> None:
    plan = {
        "outcome": "plan",
        "plan": {
            "intent": "ranking",
            "measures": ["outstanding_receivables"],
            "dimensions": [{"id": "customer.name"}],
            "time_range": {"relative": "last_n_days", "n": 730},
            "sort": [{"by": "outstanding_receivables", "direction": "desc"}],
            "limit": 6,
        },
    }
    explain = {"summary": "x", "verified_facts": [], "unknowns": []}
    tools = Sequence(ranking([500, 300, 200, 50, 40, 10], truncated=True), total_of(1200))
    r = answer_question(
        request("Which customers owe the most?"), RID, Scripted(plan, explain), tools
    )
    assert len(tools.plans) == 2 and r.execution["tool_calls"] == 2
    assert "dimensions" not in tools.plans[1]
    assert [x["playbook_id"] for x in r.recommendations] == ["receivables_concentration"]
    assert_grounded(r)

    refused = Sequence(ranking([500, 300, 200, 50, 40, 10], truncated=True), "not_authorized")
    r2 = answer_question(
        request("Which customers owe the most?"), RID, Scripted(plan, explain), refused
    )
    assert r2.status == "answered" and r2.recommendations == []  # the answer stands without it
