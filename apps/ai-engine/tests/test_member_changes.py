from datetime import datetime, timedelta, timezone
from typing import Any

from fakes import FakeTools, Scripted, tool_result
from test_recommendations import assert_grounded

from ai_engine.analysis.evidence import EvidenceLedger
from ai_engine.answer.changes import CHANGES_ID, build_member_changes, eligible
from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest
from ai_engine.llm import LlmRequest
from ai_engine.planning.view import AuthorizedView

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
RID = "11111111-2222-4333-8444-555555555555"


def measure(id: str, label: str, unit: str, polarity: str) -> dict[str, Any]:
    return {
        "id": id,
        "entity": "invoice_line",
        "label": label,
        "unit": unit,
        "polarity": polarity,
        "additivity": "non_additive" if unit == "percent" else "additive",
        "default_time_dimension": "invoice.invoice_date",
    }


VIEW = AuthorizedView.model_validate(
    {
        "semantic_model_version": 1,
        "tenant_settings": {},
        "measures": [
            measure("revenue", "Revenue", "currency", "higher_is_better"),
            measure("gross_margin_pct", "Gross margin %", "percent", "higher_is_better"),
            measure("outstanding", "Outstanding receivables", "currency", "lower_is_better"),
            measure("units", "Units sold", "quantity", "neutral"),
        ],
        "dimensions": [
            {"id": "product.name", "label": "Product", "type": "categorical"},
            {"id": "branch.name", "label": "Branch", "type": "categorical"},
            {"id": "invoice.invoice_date", "label": "Invoice date", "type": "time"},
        ],
    }
)


def plan(m: str = "gross_margin_pct", dim: str = "product.name") -> dict[str, Any]:
    return {
        "intent": "comparison",
        "measures": [m],
        "dimensions": [{"id": dim}],
        "comparison": {"type": "previous_period"},
        "time_range": {"start": "2026-10-01", "end": "2026-10-31"},
    }


def result(cur: list[list[Any]], prev: list[list[Any]], m: str, unit: str) -> Any:
    r = tool_result(cur, measure=m, unit=unit, comparison_rows=prev)
    for rs in r.result_sets:
        rs.columns[0].semantic_id = "product.name"
    return r


MARGINS_CUR = [["Cola", "18.0"], ["Chips", "30.0"], ["Rice", "12.5"], ["Oil", "20.0"]]
MARGINS_PREV = [["Cola", "21.0"], ["Chips", "29.0"], ["Rice", "15.0"], ["Oil", "20.0"]]


def test_a_comparison_by_one_dimension_is_eligible_and_others_are_not() -> None:
    assert eligible(plan())
    assert not eligible({**plan(), "dimensions": []})
    assert not eligible({**plan(), "measures": ["a", "b"]})
    assert not eligible(
        {**plan(), "dimensions": [{"id": "invoice.invoice_date", "time_grain": "month"}]}
    )
    assert not eligible({k: v for k, v in plan().items() if k != "comparison"})


def test_members_are_ordered_worst_first_and_ratios_change_in_points() -> None:
    ledger = EvidenceLedger()
    mc = build_member_changes(
        plan(), VIEW, result(MARGINS_CUR, MARGINS_PREV, "gross_margin_pct", "percent"), ledger
    )
    assert mc is not None and mc.table is not None
    assert [r[0] for r in mc.table["rows"]] == ["Cola", "Rice", "Oil", "Chips"]
    assert mc.table["rows"][0][3] == "-3.0 pp"  # a change in percentage points
    assert mc.table["rows"][0][4] is None  # no percent change of a percent
    ids = {e.id for e in ledger.items()}
    assert all(i in ids for row in mc.table["cell_evidence"] for i in row if i)
    assert mc.facts[0]["statement"].startswith("Cola: -3.0 pp")


def test_for_a_cost_like_measure_the_biggest_rise_comes_first() -> None:
    cur = [["A", "500"], ["B", "100"]]
    prev = [["A", "300"], ["B", "150"]]
    mc = build_member_changes(
        plan("outstanding"), VIEW, result(cur, prev, "outstanding", "currency"), EvidenceLedger()
    )
    assert mc is not None and mc.table is not None
    assert [r[0] for r in mc.table["rows"]] == ["A", "B"]
    assert mc.table["rows"][0][4] == "66.7%"


def test_a_neutral_measure_is_ordered_by_the_size_of_the_change() -> None:
    cur = [["A", "110"], ["B", "40"]]
    prev = [["A", "100"], ["B", "90"]]
    mc = build_member_changes(
        plan("units"), VIEW, result(cur, prev, "units", "quantity"), EvidenceLedger()
    )
    assert (
        mc is not None and mc.table is not None and [r[0] for r in mc.table["rows"]] == ["B", "A"]
    )


def test_it_will_not_rank_when_members_are_missing_or_incomparable() -> None:
    only_one_period = build_member_changes(
        plan(),
        VIEW,
        result([["Cola", "18.0"]], [["Chips", "29.0"]], "gross_margin_pct", "percent"),
        EvidenceLedger(),
    )
    assert only_one_period is None  # nothing can be compared
    cut = result(MARGINS_CUR, MARGINS_PREV, "gross_margin_pct", "percent")
    cut.result_sets[0].truncated = True
    assert build_member_changes(plan(), VIEW, cut, EvidenceLedger()) is None


def request(question: str) -> AnswerRequest:
    return AnswerRequest.model_validate(
        {
            "request_context": "signed.token",
            "question": question,
            "authorized_view": VIEW.model_dump(),
            "resolved_now": NOW.isoformat(),
        }
    )


def test_the_answer_shows_the_change_table_first_and_recommends_the_worst_member() -> None:
    planned = {
        "outcome": "plan",
        "plan": {
            "intent": "comparison",
            "measures": ["gross_margin_pct"],
            "dimensions": [{"id": "product.name"}],
            "time_range": {"relative": "last_month"},
            "comparison": {"type": "previous_period"},
        },
    }

    def explain(req: LlmRequest) -> dict[str, Any]:
        import json

        data = json.loads(req.prompt.split("<data>")[1].split("</data>")[0])
        assert data["result_sets"][0]["id"] == CHANGES_ID  # the model sees changes, not raw sets
        top = data["result_sets"][0]["rows"][0]
        return {
            "summary": f"{top['Product']} lost the most margin, {{{{{top['change']['ref']}}}}}.",
            "verified_facts": [],
            "unknowns": [],
        }

    r = answer_question(
        request("Which products have declining margins?"),
        RID,
        Scripted(planned, explain),
        FakeTools(result(MARGINS_CUR, MARGINS_PREV, "gross_margin_pct", "percent")),
    )
    assert r.status == "answered" and r.summary == "Cola lost the most margin, -3.0 pp."
    assert r.tables[0]["result_set_id"] == CHANGES_ID and len(r.tables) == 3
    assert [x["playbook_id"] for x in r.recommendations] == ["worst_member_investigate"]
    assert "Cola moved the wrong way the most (-3.0 pp)" in r.recommendations[0]["text"]
    assert_grounded(r)
