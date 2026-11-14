"""The weekly attention briefing: "what should management investigate this week?"

A fixed checklist of checks chosen by code (D-20), run through the api like any other query, and
turned into suggestions by the playbooks (D-23). No model writes any of it: the text is made from
the evidence ledger, so the briefing costs no model tokens and cannot invent a number. A check is
skipped, not guessed, when the user cannot see its measure.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from ai_engine.analysis.calculations import abs_change, pct_change
from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.answer.interpretation import describe_range
from ai_engine.answer.models import ToolResult
from ai_engine.answer.tools import DataTools, ToolError
from ai_engine.planning.time_resolver import resolve_comparison
from ai_engine.planning.view import AuthorizedView
from ai_engine.recommendations.playbooks import (
    Recommendation,
    for_comparison,
    for_customer_ranking,
    needs_total,
    recommend,
)

MAX_BRIEFING_RECOMMENDATIONS = 4
RECEIVABLES_WINDOW_DAYS = 730


@dataclass(frozen=True)
class Check:
    id: str
    measure: str
    kind: str  # "change" or "customers"


CHECKLIST = (
    Check("revenue", "revenue", "change"),
    Check("margin", "gross_margin_pct", "change"),
    Check("overdue", "overdue_receivables", "customers"),
)


def _plan(view: AuthorizedView, check: Check, period: dict[str, Any]) -> dict[str, Any]:
    base: dict[str, Any] = {
        "plan_version": "0.1",
        "semantic_model_version": view.semantic_model_version,
        "measures": [check.measure],
    }
    if check.kind == "change":
        start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
        p_start, p_end = resolve_comparison("previous_period", (start, end))
        return {
            **base,
            "intent": "comparison",
            "time_range": {"start": start.isoformat(), "end": end.isoformat()},
            "comparison": {
                "type": "previous_period",
                "time_range": {"start": p_start.isoformat(), "end": p_end.isoformat()},
            },
        }
    end_day = date.fromisoformat(period["end"])
    return {
        **base,
        "intent": "ranking",
        "dimensions": [{"id": "customer.name"}],
        "time_range": {
            "start": (end_day - timedelta(days=RECEIVABLES_WINDOW_DAYS - 1)).isoformat(),
            "end": end_day.isoformat(),
        },
        "sort": [{"by": check.measure, "direction": "desc"}],
        "limit": 10,
    }


def _ref(result: ToolResult, set_id: str, column: str, executed: str | None = None) -> ResultRef:
    return ResultRef(
        result_set_id=set_id,
        column=column,
        row=0,
        plan_hash=result.plan_hash,
        semantic_model_version=result.semantic_model_version,
        executed_at=executed or result.data_executed_at,
    )


@dataclass
class Briefing:
    summary: str
    facts: list[dict[str, Any]]
    recommendations: list[Recommendation]
    unknowns: list[str]
    interpretation: str
    calls: int
    cache_hits: int
    plan_hashes: list[str]
    sources: list[dict[str, Any]]
    freshness: list[dict[str, Any]]
    semantic_model_version: int


def run_briefing(
    view: AuthorizedView,
    period: dict[str, Any],
    tools: DataTools,
    request_context: str,
    request_id: str,
    ledger: EvidenceLedger,
) -> Briefing:
    measures = {m.id: m for m in view.measures}
    dims = {d.id for d in view.dimensions}
    facts: list[dict[str, Any]] = []
    candidates: list[Recommendation] = []
    unknowns: list[str] = []
    ran: list[str] = []
    calls = 0
    hits = 0
    hashes: list[str] = []
    sources: list[dict[str, Any]] = []
    freshness: list[dict[str, Any]] = []
    version = view.semantic_model_version

    def execute(plan: dict[str, Any]) -> ToolResult | None:
        nonlocal calls, hits
        calls += 1
        try:
            r = tools.execute_plan(request_context, request_id, plan)
        except ToolError:
            return None
        hashes.append(r.plan_hash)
        hits += int(r.cache_hit)
        for s in r.sources:
            if s not in sources:
                sources.append(s)
        for f in r.freshness:
            if f not in freshness:
                freshness.append(f)
        return r

    for check in CHECKLIST:
        m = measures.get(check.measure)
        if m is None or (check.kind == "customers" and "customer.name" not in dims):
            continue
        plan = _plan(view, check, period)
        result = execute(plan)
        if result is None:
            unknowns.append(f"{m.label} could not be checked.")
            continue
        ran.append(m.label)
        if check.kind == "change":
            cur_set = next((s for s in result.result_sets if s.role == "current"), None)
            prev_set = next((s for s in result.result_sets if s.role == "comparison"), None)
            if not cur_set or not prev_set or not cur_set.rows or not prev_set.rows:
                unknowns.append(f"{m.label}: one of the two periods has no data.")
                continue
            col = cur_set.columns[-1]
            a, b = cur_set.rows[0][-1], prev_set.rows[0][-1]
            if a is None or b is None:
                unknowns.append(f"{m.label}: one of the two periods has no data.")
                continue
            cur: Evidence = ledger.add_result(
                a, col.unit, _ref(result, cur_set.id, col.semantic_id)
            )
            prev: Evidence = ledger.add_result(
                b, col.unit, _ref(result, prev_set.id, col.semantic_id)
            )
            change = abs_change(ledger, cur, prev)
            pct = None if col.unit == "percent" else pct_change(ledger, cur, prev)
            tail = pct.display if pct else change.display
            facts.append(
                {
                    "statement": f"{m.label}: {cur.display} now, {prev.display} before ({tail}).",
                    "result_set_id": cur_set.id,
                    "evidence_ids": [e.id for e in (cur, prev, change, pct) if e],
                }
            )
            if pct is not None:
                candidates += for_comparison(view, [(f"Percent change in {m.label}", pct)])
        else:
            total_plan = needs_total(view, plan, result)
            total = execute(total_plan) if total_plan else None
            candidates += for_customer_ranking(view, plan, result, ledger, total)
            cur_set = next((s for s in result.result_sets if s.role == "current"), None)
            if cur_set and cur_set.rows and cur_set.rows[0][-1] is not None:
                col = cur_set.columns[-1]
                top = ledger.add_result(
                    cur_set.rows[0][-1],
                    col.unit,
                    ResultRef(
                        result_set_id=cur_set.id,
                        column=col.semantic_id,
                        row=0,
                        plan_hash=result.plan_hash,
                        semantic_model_version=result.semantic_model_version,
                        executed_at=result.data_executed_at,
                    ),
                )
                facts.append(
                    {
                        "statement": (
                            f"{m.label} are highest for {cur_set.rows[0][0]}: {top.display}."
                        ),
                        "result_set_id": cur_set.id,
                        "evidence_ids": [top.id],
                    }
                )

    recs = recommend(candidates, MAX_BRIEFING_RECOMMENDATIONS)
    if not ran:
        summary = "I could not run any checks for your access."
    elif recs:
        summary = "Here is what stands out."
    else:
        summary = "Nothing stands out in the checks I ran."
    where = describe_range(period)
    interp = (
        f"Checks: {', '.join(ran) if ran else 'none'} · {where} compared with the period before"
    )
    return Briefing(
        summary,
        facts,
        recs,
        unknowns,
        interp[:400],
        calls,
        hits,
        hashes,
        sources,
        freshness,
        version,
    )
