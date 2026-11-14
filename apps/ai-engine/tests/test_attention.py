from datetime import datetime, timedelta, timezone
from typing import Any

from fakes import Scripted, tool_result
from test_recommendations import assert_grounded

from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest, ToolResult
from ai_engine.answer.tools import ToolError
from ai_engine.planning.planner import plan_question
from ai_engine.planning.view import AuthorizedView

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))  # a Sunday
RID = "11111111-2222-4333-8444-555555555555"


def m(id: str, label: str, unit: str, polarity: str) -> dict[str, Any]:
    return {
        "id": id,
        "entity": "invoice",
        "label": label,
        "unit": unit,
        "polarity": polarity,
        "additivity": "non_additive" if unit == "percent" else "additive",
        "default_time_dimension": "invoice.invoice_date",
    }


def view(measures: list[str]) -> AuthorizedView:
    every = {
        "revenue": m("revenue", "Revenue", "currency", "higher_is_better"),
        "gross_margin_pct": m("gross_margin_pct", "Gross margin %", "percent", "higher_is_better"),
        "overdue_receivables": m(
            "overdue_receivables", "Overdue receivables", "currency", "lower_is_better"
        ),
    }
    return AuthorizedView.model_validate(
        {
            "semantic_model_version": 1,
            "tenant_settings": {},
            "measures": [every[x] for x in measures],
            "dimensions": [
                {"id": "customer.name", "label": "Customer", "type": "categorical"},
                {"id": "invoice.invoice_date", "label": "Invoice date", "type": "time"},
            ],
        }
    )


ATTENTION = {"outcome": "attention", "period": {"relative": "this_week"}}


class Router:
    """Answers each check by its measure; records every plan it was asked for."""

    def __init__(
        self, revenue: tuple[str, str] = ("80000", "100000"), refuse: set[str] | None = None
    ) -> None:
        self.revenue, self.refuse = revenue, refuse or set()
        self.plans: list[dict[str, Any]] = []

    def execute_plan(
        self, request_context: str, request_id: str, plan: dict[str, Any]
    ) -> ToolResult:
        self.plans.append(plan)
        measure = plan["measures"][0]
        if measure in self.refuse:
            raise ToolError("not_authorized")
        if measure == "revenue":
            r = tool_result(
                [[self.revenue[0]]],
                dimension=False,
                measure="revenue",
                comparison_rows=[[self.revenue[1]]],
            )
            r.plan_hash = "r" * 64
            return r
        if measure == "gross_margin_pct":
            r = tool_result(
                [["20.0"]],
                dimension=False,
                measure="gross_margin_pct",
                unit="percent",
                comparison_rows=[["20.5"]],
            )
            r.plan_hash = "m" * 64
            return r
        rows = [
            [f"Customer {chr(65 + i)}", str(v)] for i, v in enumerate([500, 300, 200, 50, 40, 10])
        ]
        if plan.get("dimensions"):
            r = tool_result(rows, measure="overdue_receivables")
            r.result_sets[0].truncated = True
            r.plan_hash = "o" * 64
            return r
        r = tool_result([["1200"]], dimension=False, measure="overdue_receivables")
        r.plan_hash = "t" * 64
        r.result_sets[0].id = "total-current"
        return r


def request(
    v: AuthorizedView, question: str = "What should management investigate this week?"
) -> AnswerRequest:
    return AnswerRequest.model_validate(
        {
            "request_context": "signed.token",
            "question": question,
            "authorized_view": v.model_dump(),
            "resolved_now": NOW.isoformat(),
        }
    )


def test_the_planner_turns_an_attention_question_into_an_absolute_period() -> None:
    out = plan_question("What needs attention?", view(["revenue"]), NOW, Scripted(ATTENTION))
    assert out.kind == "attention" and out.plan is None
    assert out.attention_period == {"start": "2026-11-09", "end": "2026-11-15"}
    named = plan_question(
        "anything to review this month?",
        view(["revenue"]),
        NOW,
        Scripted({"outcome": "attention", "period": {"relative": "this_month"}}),
    )
    assert named.attention_period == {"start": "2026-11-01", "end": "2026-11-15"}
    bad = plan_question(
        "x",
        view(["revenue"]),
        NOW,
        Scripted({"outcome": "attention", "period": {"relative": "last_n_days"}}),
    )
    assert bad.kind == "attention" and bad.attention_period == {
        "start": "2026-11-09",
        "end": "2026-11-15",
    }


def test_the_briefing_runs_its_checks_and_recommends_without_any_model_text() -> None:
    v, api = view(["revenue", "gross_margin_pct", "overdue_receivables"]), Router()
    model = Scripted(ATTENTION)
    r = answer_question(request(v), RID, model, api)
    assert r.status == "answered" and r.intent == "recommendation"
    assert len(model.requests) == 1  # only the planner: the briefing costs no explainer tokens
    assert (
        r.execution["usage"]["explainer"]["calls"] == 0
        and r.execution["grounding"] == "not_applicable"
    )
    assert r.summary == "Here is what stands out."
    assert [x["playbook_id"] for x in r.recommendations] == [
        "material_decline_investigate",
        "receivables_concentration",
    ]
    assert r.interpretation == (
        "Checks: Revenue, Gross margin %, Overdue receivables · 9 Nov 2026 to 15 Nov 2026 "
        "compared with the period before"
    )
    assert any(
        f["statement"].startswith("Revenue: ₹80,000 now, ₹1.00 lakh before (-20.0%)")
        for f in r.verified_facts
    )
    assert any("highest for Customer A" in f["statement"] for f in r.verified_facts)
    assert_grounded(r)
    # the checks asked the api for what the plans say, within the budget
    assert r.execution["tool_calls"] == len(api.plans) <= 6
    assert api.plans[0]["comparison"]["time_range"] == {"start": "2026-11-02", "end": "2026-11-08"}
    assert sorted(set(r.execution["plan_hashes"])) == sorted(
        ["r" * 64, "m" * 64, "o" * 64, "t" * 64]
    )


def test_nothing_is_invented_when_nothing_stands_out() -> None:
    v = view(["revenue", "gross_margin_pct"])
    r = answer_question(request(v), RID, Scripted(ATTENTION), Router(revenue=("101000", "100000")))
    assert r.summary == "Nothing stands out in the checks I ran." and r.recommendations == []
    assert r.verified_facts  # what was looked at is still shown


def test_a_check_the_user_cannot_see_is_skipped_and_a_refused_one_is_reported() -> None:
    only_revenue = answer_question(request(view(["revenue"])), RID, Scripted(ATTENTION), Router())
    assert (only_revenue.interpretation or "").startswith("Checks: Revenue ·")
    refused = answer_question(
        request(view(["revenue", "gross_margin_pct"])),
        RID,
        Scripted(ATTENTION),
        Router(refuse={"gross_margin_pct"}),
    )
    assert "Gross margin % could not be checked." in refused.unknowns
    assert refused.status == "answered" and refused.recommendations  # the rest still ran


def test_with_no_visible_measure_it_says_so() -> None:
    r = answer_question(request(view([])), RID, Scripted({"outcome": "out_of_scope"}), Router())
    assert r.status == "out_of_scope"  # no measures at all: the planner is not even asked
    nothing = answer_question(
        request(view(["revenue"])), RID, Scripted(ATTENTION), Router(refuse={"revenue"})
    )
    assert nothing.summary == "I could not run any checks for your access."


def test_the_briefing_counts_cache_hits_across_its_checks() -> None:
    class Warm(Router):
        def execute_plan(
            self, request_context: str, request_id: str, plan: dict[str, Any]
        ) -> ToolResult:
            r = super().execute_plan(request_context, request_id, plan)
            r.cache_hit = True
            return r

    v = view(["revenue", "gross_margin_pct"])
    r = answer_question(request(v), RID, Scripted(ATTENTION), Warm())
    assert (
        r.execution["cache"] == {"exact_result_hits": r.execution["tool_calls"]}
        and r.execution["tool_calls"] == 2
    )
