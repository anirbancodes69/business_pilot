"""Turns an Investigation into evidence, a findings table and text inputs for the explainer.

Every figure here is a ledger record: either a cell of a result set (`result`) or a calculation made
by code (`derived`). The explainer sees evidence ids and rendered text, never a raw number.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ai_engine.analysis.calculations import (
    abs_change,
    contribution_to_delta,
    one_period_change,
    pct_change,
    sum_of_changes,
)
from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.answer.models import ToolResult, ToolResultSet
from ai_engine.investigation.engine import Driver, Investigation, MemberDelta, Step
from ai_engine.planning.view import AuthorizedView

FINDINGS_ID = "findings"
MAX_SUM_MEMBERS = 30


@dataclass
class DriverFinding:
    """The evidence behind one row of the findings table, for recommendations to cite."""

    depth: int
    where: str
    label: str  # the member's own label, for example "Nashik"
    parent: str | None
    change: Evidence
    share: Evidence | None


@dataclass
class Findings:
    drivers: list[DriverFinding] = field(default_factory=list)
    total_change: Evidence | None = None
    data: list[dict[str, Any]] = field(default_factory=list)  # for the explainer
    derived: list[tuple[str, Evidence]] = field(default_factory=list)
    table: dict[str, Any] | None = None
    facts: list[dict[str, Any]] = field(default_factory=list)  # code-written, for degraded answers
    unknowns: list[str] = field(default_factory=list)


def _ref(result: ToolResult, rs: ToolResultSet, column: str, row: int) -> ResultRef:
    return ResultRef(
        result_set_id=rs.id,
        column=column,
        row=row,
        plan_hash=result.plan_hash,
        semantic_model_version=result.semantic_model_version,
        executed_at=result.data_executed_at,
    )


def _member_evidence(
    ledger: EvidenceLedger, step: Step, m: MemberDelta
) -> tuple[Evidence | None, Evidence | None, Evidence]:
    cur = (
        ledger.add_result(
            m.current, step.unit, _ref(step.result, step.current_set, step.column, m.cur_row)
        )
        if m.current is not None and m.cur_row is not None
        else None
    )
    prev = (
        ledger.add_result(
            m.previous, step.unit, _ref(step.result, step.previous_set, step.column, m.prev_row)
        )
        if m.previous is not None and m.prev_row is not None
        else None
    )
    if cur is not None and prev is not None:
        change = abs_change(ledger, cur, prev)
    elif cur is not None:
        change = one_period_change(ledger, cur, appeared=True)
    elif prev is not None:
        change = one_period_change(ledger, prev, appeared=False)
    else:
        raise ValueError("a member with no value in either period")
    return cur, prev, change


def build_findings(inv: Investigation, ledger: EvidenceLedger, view: AuthorizedView) -> Findings:
    out = Findings()
    dims = {d.id: d.label for d in view.dimensions}
    total = inv.total
    if total is None or not total.current_set.rows or not total.previous_set.rows:
        return out
    t_cur = ledger.add_result(
        total.current_set.rows[0][-1],
        total.unit,
        _ref(total.result, total.current_set, total.column, 0),
    )
    t_prev = ledger.add_result(
        total.previous_set.rows[0][-1],
        total.unit,
        _ref(total.result, total.previous_set, total.column, 0),
    )
    t_change = abs_change(ledger, t_cur, t_prev)
    out.total_change = t_change
    out.derived.append((f"Change in {inv.label}", t_change))
    pct = pct_change(ledger, t_cur, t_prev)
    if pct is not None:
        out.derived.append((f"Percent change in {inv.label}", pct))

    # Parent totals for depth-2 shares: the sum of the drill step's own member changes.
    parent_total: dict[int, Evidence] = {}
    rows: list[dict[str, Any]] = []
    table_rows: list[list[str | None]] = []
    table_ids: list[list[str | None]] = []

    def parent_for(step: Step) -> Evidence | None:
        key = id(step)
        if key in parent_total:
            return parent_total[key]
        if (
            len(step.members) > MAX_SUM_MEMBERS
            or step.current_set.truncated
            or step.previous_set.truncated
        ):
            return None
        changes = [_member_evidence(ledger, step, m)[2] for m in step.members]
        parent_total[key] = sum_of_changes(ledger, changes)
        return parent_total[key]

    for d in inv.drivers:
        cur, prev, change = _member_evidence(ledger, d.step, d.member)
        denom = t_change if d.depth == 1 else parent_for(d.step)
        share = contribution_to_delta(ledger, change, denom) if denom is not None else None
        where = f"{dims.get(d.step.dimension or '', d.step.dimension)}: {d.member.label}"
        if d.depth == 2 and d.parent_label:
            where = f"{d.parent_label} › {where}"
        row: dict[str, Any] = {"where": where}
        for key, ev in (
            ("previous", prev),
            ("current", cur),
            ("change", change),
            ("share_of_change", share),
        ):
            if ev is not None:
                row[key] = {"ref": ev.id, "shown": ev.display}
        rows.append(row)
        table_rows.append(
            [
                where,
                prev.display if prev else None,
                cur.display if cur else None,
                change.display,
                share.display if share else None,
            ]
        )
        table_ids.append(
            [
                None,
                prev.id if prev else None,
                cur.id if cur else None,
                change.id,
                share.id if share else None,
            ]
        )
        facts = {
            "statement": f"{where}: {change.display}"
            + (f" ({share.display} of the change)" if share else ""),
            "result_set_id": FINDINGS_ID,
            "evidence_ids": [e.id for e in (change, share) if e is not None],
        }
        out.facts.append(facts)
        out.drivers.append(
            DriverFinding(d.depth, where, d.member.label, d.parent_label, change, share)
        )

    out.data = [{"id": FINDINGS_ID, "period": "investigation", "rows": rows}]
    out.table = {
        "result_set_id": FINDINGS_ID,
        "title": f"What drove the change in {inv.label}",
        "period": "current",
        "as_of": total.result.data_executed_at,
        "truncated": False,
        "columns": [
            {"semantic_id": "where", "label": "Where", "kind": "dimension"},
            {"semantic_id": "previous", "label": "Previous", "kind": "measure"},
            {"semantic_id": "current", "label": "Current", "kind": "measure"},
            {"semantic_id": "change", "label": "Change", "kind": "measure"},
            {"semantic_id": "share", "label": "Share of change", "kind": "measure"},
        ],
        "rows": table_rows,
        "cell_evidence": table_ids,
    }
    out.unknowns = list(inv.unknowns)
    if inv.used_breakdown_measure:
        out.unknowns.append(
            "Product-level figures use line revenue (before tax), so they are close to, "
            "but not exactly, the revenue figures."
        )
    if inv.stop == "spread":
        out.unknowns.append("No single cause stands out: the change is spread across many parts.")
    if inv.stop == "budget":
        out.unknowns.append("The investigation stopped at its step limit.")
    return out


def share_is_positive(d: Driver) -> bool:
    return d.share > Decimal(0)
