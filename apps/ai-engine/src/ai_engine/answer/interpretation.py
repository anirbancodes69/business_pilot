"""How a question was understood, in plain words, built by code from the plan that actually ran.

Shown to the user so assumptions (the period, a filter carried over from a follow-up) are visible.
The text is made only from catalog labels, the plan's values and dates: no model is involved.
"""

from datetime import date
from typing import Any

from ai_engine.planning.view import AuthorizedView

GRAINS = {
    "day": "day",
    "week": "week",
    "month": "month",
    "quarter": "quarter",
    "fiscal_quarter": "fiscal quarter",
    "year": "year",
    "fiscal_year": "fiscal year",
}


def _day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.day} {d:%b %Y}"


def _range(r: dict[str, Any]) -> str:
    start, end = r["start"], r["end"]
    return _day(start) if start == end else f"{_day(start)} to {_day(end)}"


def interpret(plan: dict[str, Any], view: AuthorizedView) -> str:
    labels = {m.id: m.label for m in view.measures} | {d.id: d.label for d in view.dimensions}
    head = " and ".join(labels.get(m, m) for m in plan["measures"])
    dims = []
    for d in plan.get("dimensions", []):
        grain = f" ({GRAINS[d['time_grain']]})" if d.get("time_grain") else ""
        dims.append(f"{labels.get(d['id'], d['id'])}{grain}")
    if dims:
        head += " by " + ", ".join(dims)
    parts = [head, _range(plan["time_range"])]
    for f in plan.get("filters", []):
        op = {"eq": "is", "in": "is one of", "neq": "is not", "not_in": "is not one of"}.get(
            f["operator"], f["operator"]
        )
        parts.append(
            f"{labels.get(f['dimension'], f['dimension'])} {op} {', '.join(map(str, f['values']))}"
        )
    cmp_range = (plan.get("comparison") or {}).get("time_range")
    if cmp_range:
        parts.append(f"compared with {_range(cmp_range)}")
    if plan.get("limit") and plan.get("dimensions"):
        parts.append(f"top {plan['limit']}")
    return " · ".join(parts)[:400]
