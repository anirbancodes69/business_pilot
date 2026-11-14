"""Playbooks: rules that turn findings into suggestions worth a person's attention.

Code decides whether a recommendation exists and what it says; no model is involved in this
version. A recommendation is a suggestion to look at something or to ask a further question. It
never triggers anything in a customer's systems. It cites the evidence it rests on: without at
least one evidence id it is not produced (`recommend` drops it), and every number in its text is
rendered from the ledger. Thresholds are constants here; moving them into the tenant's business
rules is still open.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from ai_engine.analysis.calculations import share_of_total, sum_of_values
from ai_engine.analysis.evidence import Evidence, EvidenceLedger, ResultRef
from ai_engine.answer.findings import Findings
from ai_engine.answer.models import ToolResult
from ai_engine.planning.view import AuthorizedView, ViewMeasure

MATERIAL_CHANGE_PCT = Decimal(10)
CONCENTRATION_SHARE_PCT = Decimal(50)
CONCENTRATION_TOP = 3
MIN_ROWS_FOR_CONCENTRATION = 5
DOMINANT_SHARE_PCT = Decimal(50)
MAX_RECOMMENDATIONS = 2


@dataclass(frozen=True)
class Recommendation:
    text: str
    playbook_id: str
    evidence_ids: tuple[str, ...]


def _measure(view: AuthorizedView, measure_id: str) -> ViewMeasure | None:
    return next((m for m in view.measures if m.id == measure_id), None)


def _lower(label: str) -> str:
    return label[:1].lower() + label[1:]


def for_comparison(
    view: AuthorizedView, derived: list[tuple[str, Evidence]]
) -> list[Recommendation]:
    """A material move in a plain figure against the other period."""
    out: list[Recommendation] = []
    for label, ev in derived:
        if not label.startswith("Percent change in "):
            continue
        name = label.removeprefix("Percent change in ")
        m = next((x for x in view.measures if x.label == name), None)
        if m is None or m.polarity not in ("higher_is_better", "lower_is_better"):
            continue
        change = Decimal(str(ev.value))
        if m.polarity == "higher_is_better" and change <= -MATERIAL_CHANGE_PCT:
            out.append(
                Recommendation(
                    f"{name} changed by {ev.display}. Ask “Why did {_lower(name)} drop?” to see "
                    "which parts of the business drove it.",
                    "material_decline_investigate",
                    (ev.id,),
                )
            )
        elif m.polarity == "lower_is_better" and change >= MATERIAL_CHANGE_PCT:
            out.append(
                Recommendation(
                    f"{name} changed by {ev.display}, which is the wrong direction. Review which "
                    "customers account for it.",
                    "material_increase_review",
                    (ev.id,),
                )
            )
    return out


def _eligible(view: AuthorizedView, plan: dict[str, Any]) -> ViewMeasure | None:
    dims = plan.get("dimensions") or []
    if len(dims) != 1 or dims[0]["id"] != "customer.name" or len(plan["measures"]) != 1:
        return None
    if (plan.get("sort") or [{}])[0].get("direction") == "asc":
        return None  # the visible rows would not be the largest ones
    m = _measure(view, plan["measures"][0])
    if m is None or m.polarity != "lower_is_better" or m.unit != "currency":
        return None
    return m


def needs_total(
    view: AuthorizedView, plan: dict[str, Any], result: ToolResult
) -> dict[str, Any] | None:
    """The plan for the overall total, when a ranking was cut short and the concentration playbook
    could still apply. The same filters and period, no grouping: one cheap extra data call."""
    rs = next((s for s in result.result_sets if s.role == "current"), None)
    if _eligible(view, plan) is None or rs is None or not rs.truncated:
        return None
    total = {
        k: v for k, v in plan.items() if k not in ("dimensions", "sort", "limit", "comparison")
    }
    total["intent"] = "metric"
    return total


def for_customer_ranking(
    view: AuthorizedView,
    plan: dict[str, Any],
    result: ToolResult,
    ledger: EvidenceLedger,
    total: ToolResult | None = None,
) -> list[Recommendation]:
    """Money owed is held by a few customers: a reason to prioritise follow-up with them."""
    m = _eligible(view, plan)
    rs = next((s for s in result.result_sets if s.role == "current"), None)
    if m is None or rs is None:
        return []
    col = rs.columns[-1]
    rows: list[tuple[str, int, Decimal]] = []
    for i, row in enumerate(rs.rows):
        if row[0] is None or row[-1] is None:
            continue
        rows.append((str(row[0]), i, Decimal(str(row[-1]))))
    rows.sort(key=lambda r: (-r[2], r[0]))
    if len(rows) < MIN_ROWS_FOR_CONCENTRATION:
        return []  # a handful of rows proves nothing

    def evidence(
        rset: Any, res: ToolResult, column: str, unit: str | None, i: int, v: Any
    ) -> Evidence:
        ref = ResultRef(
            result_set_id=rset.id,
            column=column,
            row=i,
            plan_hash=res.plan_hash,
            semantic_model_version=res.semantic_model_version,
            executed_at=res.data_executed_at,
        )
        return ledger.add_result(v, unit, ref)

    top = rows[:CONCENTRATION_TOP]
    top_sum = sum_of_values(
        ledger, [evidence(rs, result, col.semantic_id, col.unit, i, v) for _, i, v in top]
    )
    if not rs.truncated:
        all_total = sum_of_values(
            ledger, [evidence(rs, result, col.semantic_id, col.unit, i, v) for _, i, v in rows]
        )
    else:
        # Rows were cut, so the sum of what is shown is not the total: it needs its own figure.
        if total is None:
            return []
        t_cur = next((s for s in total.result_sets if s.role == "current"), None)
        if t_cur is None or not t_cur.rows or t_cur.rows[0][-1] is None:
            return []
        all_total = evidence(
            t_cur, total, t_cur.columns[-1].semantic_id, col.unit, 0, t_cur.rows[0][-1]
        )
    share = share_of_total(ledger, top_sum, all_total)
    if share is None or Decimal(str(share.value)) < CONCENTRATION_SHARE_PCT:
        return []
    names = ", ".join(n for n, _, _ in top)
    return [
        Recommendation(
            f"{names} hold {share.display} of the {_lower(m.label)}. Prioritise follow-up with "
            "them first.",
            "receivables_concentration",
            (share.id,),
        )
    ]


def for_member_changes(changes: Any) -> list[Recommendation]:
    """The member whose change is worst, when it is a move in the wrong direction."""
    m = changes.measure
    if m.polarity not in ("higher_is_better", "lower_is_better") or not changes.members:
        return []
    worst = changes.members[0]
    wrong = worst.delta < 0 if m.polarity == "higher_is_better" else worst.delta > 0
    if not wrong:
        return []
    return [
        Recommendation(
            f"{worst.label} moved the wrong way the most ({worst.change.display}). Ask "
            f"\u201cWhy did {_lower(m.label)} change for {worst.label}?\u201d to find out why.",
            "worst_member_investigate",
            (worst.change.id,),
        )
    ]


def for_investigation(
    findings: Findings, view: AuthorizedView, measure_id: str
) -> list[Recommendation]:
    """A change that is mostly one part of the business, and what to look at inside it."""
    m = _measure(view, measure_id)
    total = findings.total_change
    out: list[Recommendation] = []
    if total is None:
        return out
    direction = Decimal(str(total.value))
    bad = (m is not None and m.polarity == "higher_is_better" and direction < 0) or (
        m is not None and m.polarity == "lower_is_better" and direction > 0
    )
    word = "decline" if direction < 0 else "increase"
    first = next((d for d in findings.drivers if d.depth == 1 and d.share is not None), None)
    if first is not None and first.share is not None:
        if Decimal(str(first.share.value)) >= DOMINANT_SHARE_PCT:
            what = (
                "Review what happened there first."
                if bad
                else "Find out what worked there and whether it can be repeated."
            )
            out.append(
                Recommendation(
                    f"{first.where} accounts for {first.share.display} of the {word}. {what}",
                    "dominant_driver_review",
                    (first.share.id,),
                )
            )
    second = next((d for d in findings.drivers if d.depth == 2 and d.share is not None), None)
    if second is not None and second.share is not None:
        if Decimal(str(second.share.value)) >= DOMINANT_SHARE_PCT:
            out.append(
                Recommendation(
                    f"Inside {second.parent}, {second.label} is {second.share.display} of the "
                    f"{word}. Check its stock, pricing and customer orders.",
                    "driver_second_level",
                    (second.share.id,),
                )
            )
    return out


def recommend(
    candidates: list[Recommendation], limit: int = MAX_RECOMMENDATIONS
) -> list[Recommendation]:
    """At most two, each with evidence, without repeats. A recommendation without a citation is
    dropped: that is the rule of D-23, enforced here rather than trusted to any playbook."""
    seen: set[str] = set()
    out: list[Recommendation] = []
    for r in candidates:
        if not r.evidence_ids or r.playbook_id in seen:
            continue
        seen.add(r.playbook_id)
        out.append(r)
    return out[:limit]
