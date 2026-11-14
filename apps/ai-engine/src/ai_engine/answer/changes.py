"""How each member of one dimension changed between two periods (code, in Decimal).

Used for "which products have declining margins?" and "which branches are performing poorly?":
a comparison plan with one dimension. Works for any measure, including ratios (whose parts do not
add up, so no share-of-total is claimed). Members are ordered with the worst first when the measure
says which direction is good. Every figure is a ledger record.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ai_engine.analysis.calculations import abs_change, pct_change
from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.answer.models import ToolResult, ToolResultSet
from ai_engine.planning.view import AuthorizedView, ViewMeasure

CHANGES_ID = "changes"
MAX_ROWS = 10


@dataclass
class MemberChange:
    label: str
    previous: Evidence
    current: Evidence
    change: Evidence
    pct: Evidence | None
    delta: Decimal


@dataclass
class MemberChanges:
    measure: ViewMeasure
    dimension_label: str
    members: list[MemberChange] = field(default_factory=list)
    data: list[dict[str, Any]] = field(default_factory=list)  # for the explainer
    table: dict[str, Any] | None = None
    facts: list[dict[str, Any]] = field(default_factory=list)  # code-written, for degraded answers
    note: str = ""


def eligible(plan: dict[str, Any]) -> bool:
    return (
        plan.get("intent") == "comparison"
        and bool(plan.get("comparison"))
        and len(plan.get("dimensions") or []) == 1
        and len(plan["measures"]) == 1
        and not (plan["dimensions"][0].get("time_grain"))
    )


def _ref(result: ToolResult, rs: ToolResultSet, column: str, row: int) -> ResultRef:
    return ResultRef(
        result_set_id=rs.id,
        column=column,
        row=row,
        plan_hash=result.plan_hash,
        semantic_model_version=result.semantic_model_version,
        executed_at=result.data_executed_at,
    )


def build_member_changes(
    plan: dict[str, Any], view: AuthorizedView, result: ToolResult, ledger: EvidenceLedger
) -> MemberChanges | None:
    cur = next((s for s in result.result_sets if s.role == "current"), None)
    prev = next((s for s in result.result_sets if s.role == "comparison"), None)
    measure = next((m for m in view.measures if m.id == plan["measures"][0]), None)
    dim = next((d for d in view.dimensions if d.id == plan["dimensions"][0]["id"]), None)
    if cur is None or prev is None or measure is None or dim is None:
        return None
    if cur.truncated or prev.truncated:
        return None  # members are missing: a ranking of changes would mislead
    col = cur.columns[-1]

    def read(rs: ToolResultSet) -> dict[str, tuple[int, Any]]:
        return {(NONE if r[0] is None else str(r[0])): (i, r[-1]) for i, r in enumerate(rs.rows)}

    NONE = "(none)"
    c, p = read(cur), read(prev)
    out = MemberChanges(measure, dim.label)
    for label in dict.fromkeys([*c, *p]):
        ce = (
            ledger.add_result(
                c[label][1], col.unit, _ref(result, cur, col.semantic_id, c[label][0])
            )
            if label in c and c[label][1] is not None
            else None
        )
        pe = (
            ledger.add_result(
                p[label][1], col.unit, _ref(result, prev, col.semantic_id, p[label][0])
            )
            if label in p and p[label][1] is not None
            else None
        )
        if ce is None or pe is None:
            continue  # present in one period only: not comparable for a ratio, skipped on purpose
        change = abs_change(ledger, ce, pe)
        pct = None if col.unit == "percent" else pct_change(ledger, ce, pe)
        out.members.append(
            MemberChange(
                label, pe, ce, change, pct, Decimal(str(ce.value)) - Decimal(str(pe.value))
            )
        )
    if not out.members:
        return None
    worst_first = measure.polarity != "lower_is_better"
    neutral = measure.polarity not in ("higher_is_better", "lower_is_better")
    if neutral:
        out.members.sort(key=lambda m: (-abs(m.delta), m.label))
    else:
        out.members.sort(key=lambda m: (m.delta if worst_first else -m.delta, m.label))
    shown = out.members[:MAX_ROWS]
    out.note = (
        "Rows are ordered with the biggest change first."
        if neutral
        else "Rows are ordered from the worst change to the best."
    )
    rows, ids = [], []
    for m in shown:
        rows.append(
            [
                m.label,
                m.previous.display,
                m.current.display,
                m.change.display,
                m.pct.display if m.pct else None,
            ]
        )
        ids.append([None, m.previous.id, m.current.id, m.change.id, m.pct.id if m.pct else None])
        out.facts.append(
            {
                "statement": (
                    f"{m.label}: {m.change.display} ({m.previous.display} to {m.current.display})"
                ),
                "result_set_id": CHANGES_ID,
                "evidence_ids": [m.change.id],
            }
        )
    out.data = [
        {
            "id": CHANGES_ID,
            "period": "change",
            "rows": [
                {
                    dim.label: m.label,
                    "previous": {"ref": m.previous.id, "shown": m.previous.display},
                    "current": {"ref": m.current.id, "shown": m.current.display},
                    "change": {"ref": m.change.id, "shown": m.change.display},
                    **(
                        {"percent_change": {"ref": m.pct.id, "shown": m.pct.display}}
                        if m.pct
                        else {}
                    ),
                }
                for m in shown
            ],
        }
    ]
    out.table = {
        "result_set_id": CHANGES_ID,
        "title": f"How {measure.label.lower()} changed by {dim.label.lower()}",
        "period": "current",
        "as_of": result.data_executed_at,
        "truncated": len(out.members) > MAX_ROWS,
        "columns": [
            {"semantic_id": "member", "label": dim.label, "kind": "dimension"},
            {"semantic_id": "previous", "label": "Previous", "kind": "measure"},
            {"semantic_id": "current", "label": "Current", "kind": "measure"},
            {"semantic_id": "change", "label": "Change", "kind": "measure"},
            {"semantic_id": "percent_change", "label": "% change", "kind": "measure"},
        ],
        "rows": rows,
        "cell_evidence": ids,
    }
    return out
