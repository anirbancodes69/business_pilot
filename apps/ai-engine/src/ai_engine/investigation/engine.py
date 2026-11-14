"""Investigation engine: "why did X change?" answered by a small fixed procedure, not by the model.

Procedure (a closed step catalog, a hard call budget, deterministic stop rules):
  1. TOTAL      the measure for both periods, to know how much changed.
  2. BREAKDOWN  up to three first-level dimensions, each split by member; rank the dimensions by how
                much of the change their largest member explains.
  3. DRILL      into the largest member of the best dimension, split by up to two other dimensions
                (using the measure's `breakdown_measure` when the dimension needs it).
Every step is one QueryPlan that the api re-authorizes. A step the api refuses ends that branch
and is reported, never retried with a different scope. Numbers are `Decimal`; nothing here calls
a model.
"""

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

from ai_engine.answer.models import ToolResult, ToolResultSet
from ai_engine.answer.tools import ToolError
from ai_engine.planning.view import AuthorizedView, ViewDimension, ViewMeasure

Execute = Callable[[dict[str, Any]], ToolResult]

MAX_CALLS = 6
FIRST_LEVEL = 3
DRILL_DIMS = 2
DOMINANT_SHARE = Decimal("0.30")
MAX_DRIVERS_L1 = 3
MAX_DRIVERS_L2 = 2
NONE_LABEL = "(none)"


@dataclass
class MemberDelta:
    label: str
    current: Decimal | None
    previous: Decimal | None
    cur_row: int | None
    prev_row: int | None

    @property
    def delta(self) -> Decimal:
        return (self.current or Decimal(0)) - (self.previous or Decimal(0))


@dataclass
class Step:
    """One executed breakdown (or the total, when `dimension` is None)."""

    measure: str
    dimension: str | None
    filters: list[tuple[str, str]]
    result: ToolResult
    column: str
    unit: str | None
    current_set: ToolResultSet
    previous_set: ToolResultSet
    members: list[MemberDelta] = field(default_factory=list)

    @property
    def total_delta(self) -> Decimal:
        return sum((m.delta for m in self.members), Decimal(0))


@dataclass
class Driver:
    depth: int
    step: Step
    member: MemberDelta
    share: Decimal  # of the total change (depth 1) or of the parent member's change (depth 2)
    parent_label: str | None = None


StopReason = Literal["no_change", "dominant_driver", "spread", "budget", "unsupported", "no_data"]


@dataclass
class Investigation:
    measure: str
    label: str
    total: Step | None = None
    tried: list[Step] = field(default_factory=list)
    drill: list[Step] = field(default_factory=list)
    drivers: list[Driver] = field(default_factory=list)
    stop: StopReason = "no_data"
    calls: int = 0
    unknowns: list[str] = field(default_factory=list)
    used_breakdown_measure: bool = False


def _dec(v: Any) -> Decimal | None:
    return None if v is None else Decimal(str(v))


def _sets(result: ToolResult) -> tuple[ToolResultSet, ToolResultSet] | None:
    cur = next((s for s in result.result_sets if s.role == "current"), None)
    prev = next((s for s in result.result_sets if s.role == "comparison"), None)
    return (cur, prev) if cur and prev else None


def _members(cur: ToolResultSet, prev: ToolResultSet) -> list[MemberDelta]:
    def read(rs: ToolResultSet) -> dict[str, tuple[Decimal | None, int]]:
        out: dict[str, tuple[Decimal | None, int]] = {}
        for i, row in enumerate(rs.rows):
            label = NONE_LABEL if row[0] is None else str(row[0])
            out[label] = (_dec(row[-1]), i)
        return out

    c, p = read(cur), read(prev)
    return [
        MemberDelta(
            label,
            c[label][0] if label in c else None,
            p[label][0] if label in p else None,
            c[label][1] if label in c else None,
            p[label][1] if label in p else None,
        )
        for label in dict.fromkeys([*c, *p])
    ]


def _supports(m: ViewMeasure, dim: str) -> bool:
    return m.valid_dimensions is None or dim in m.valid_dimensions


def _representatives(candidates: list[ViewDimension]) -> list[ViewDimension]:
    """Standalone dimensions plus the finest of levels 1-2 per hierarchy, in the view's order."""
    finest: dict[str, ViewDimension] = {}
    for d in candidates:
        if d.hierarchy is not None and d.hierarchy.level <= 2:
            best = finest.get(d.hierarchy.name)
            if best is None or (best.hierarchy and best.hierarchy.level < d.hierarchy.level):
                finest[d.hierarchy.name] = d
    return [d for d in candidates if d.hierarchy is None or finest.get(d.hierarchy.name) is d]


def _first_level(view: AuthorizedView, m: ViewMeasure) -> list[ViewDimension]:
    """Diagnostic, categorical dimensions the measure supports, one per hierarchy."""
    cands = [
        d
        for d in view.dimensions
        if d.diagnostic and d.type == "categorical" and _supports(m, d.id)
    ]
    return _representatives(cands)[:FIRST_LEVEL]


def _drill_dims(
    view: AuthorizedView, used: set[str], blocked_hierarchies: set[str]
) -> list[ViewDimension]:
    cands = [
        d
        for d in view.dimensions
        if d.diagnostic
        and d.type == "categorical"
        and d.id not in used
        and not (d.hierarchy and d.hierarchy.name in blocked_hierarchies)
    ]
    return _representatives(cands)


def _plan(
    base: dict[str, Any], measure: str, dimension: str | None, filters: list[tuple[str, str]]
) -> dict[str, Any]:
    p = deepcopy(base)
    p.update({"measures": [measure], "intent": "diagnostic", "limit": 100})
    p.pop("sort", None)
    p.pop("breakdowns", None)
    if dimension:
        p["dimensions"] = [{"id": dimension}]
    else:
        p.pop("dimensions", None)
    extra = [{"dimension": d, "operator": "eq", "values": [m]} for d, m in filters]
    if extra or p.get("filters"):
        p["filters"] = [*p.get("filters", []), *extra]
    return p


def _sign(total_delta: Decimal) -> int:
    return -1 if total_delta < 0 else 1


def _top_share(step: Step, total_delta: Decimal) -> Decimal:
    """Share of the change explained by the largest same-direction member (0 if not told)."""
    if total_delta == 0 or len(step.members) < 2:
        return Decimal(0)
    s = _sign(total_delta)
    best = max((m.delta * s for m in step.members), default=Decimal(0))
    return max(best, Decimal(0)) / abs(total_delta)


def _drivers_of(
    step: Step, total_delta: Decimal, depth: int, limit: int, parent: str | None
) -> list[Driver]:
    s = _sign(total_delta)
    ranked = sorted(step.members, key=lambda m: m.delta * s, reverse=True)
    out = [
        Driver(depth, step, m, m.delta / total_delta, parent) for m in ranked if m.delta * s > 0
    ][:limit]
    return out


def investigate(base_plan: dict[str, Any], view: AuthorizedView, execute: Execute) -> Investigation:
    """Raises ToolError only if the first (total) step fails; later failures end their branch."""
    measure_id = base_plan["measures"][0]
    measures = {m.id: m for m in view.measures}
    vm = measures.get(measure_id)
    inv = Investigation(measure=measure_id, label=vm.label if vm else measure_id)
    if vm is None or vm.additivity not in (None, "additive"):
        inv.stop = "unsupported"
        inv.unknowns.append("This measure cannot be broken down into parts that add up.")
        return inv

    def run(measure: str, dim: str | None, filters: list[tuple[str, str]]) -> Step | None:
        if inv.calls >= MAX_CALLS:
            return None
        inv.calls += 1
        result = execute(_plan(base_plan, measure, dim, filters))
        pair = _sets(result)
        if pair is None:
            return None
        col = pair[0].columns[-1]
        step = Step(measure, dim, filters, result, col.semantic_id, col.unit, pair[0], pair[1])
        step.members = _members(*pair)
        return step

    total = run(measure_id, None, [])
    if total is None:
        inv.unknowns.append("The comparison could not be read.")
        return inv
    inv.total = total
    cur = _dec(total.current_set.rows[0][-1]) if total.current_set.rows else None
    prev = _dec(total.previous_set.rows[0][-1]) if total.previous_set.rows else None
    if cur is None or prev is None:
        inv.stop = "no_data"
        inv.unknowns.append("One of the two periods has no data for this measure.")
        return inv
    total_delta = cur - prev
    if total_delta == 0:
        inv.stop = "no_change"
        return inv

    refused: set[str] = set()

    def safe(measure: str, dim: str, filters: list[tuple[str, str]]) -> Step | None:
        try:
            return run(measure, dim, filters)
        except ToolError as e:
            if e.kind in ("not_authorized", "invalid_plan"):
                # The branch ends here. The same dimension is never asked again, with any scope.
                refused.add(dim)
                msg = "Some breakdowns were not available for your access."
                if msg not in inv.unknowns:
                    inv.unknowns.append(msg)
                return None
            raise

    for dim in _first_level(view, vm):
        step = safe(measure_id, dim.id, [])
        if step is not None:
            inv.tried.append(step)
    ranked = sorted(inv.tried, key=lambda s: _top_share(s, total_delta), reverse=True)
    best = ranked[0] if ranked else None
    if best is None or _top_share(best, total_delta) == 0:
        inv.stop = "spread"
        inv.unknowns.append("No single dimension explains the change.")
        return inv

    inv.drivers = _drivers_of(best, total_delta, 1, MAX_DRIVERS_L1, None)
    top = inv.drivers[0] if inv.drivers else None
    if top is None or abs(top.share) < DOMINANT_SHARE:
        inv.stop = "spread"
        return inv
    inv.stop = "dominant_driver"
    if inv.calls >= MAX_CALLS:
        inv.stop = "budget"
        return inv

    # DRILL into the largest member, by dimensions the first level did not use.
    best_dim = next(d for d in view.dimensions if d.id == best.dimension)
    blocked = {best_dim.hierarchy.name} if best_dim.hierarchy else set()
    used = {s.dimension for s in inv.tried if s.dimension} | refused
    drill_filters = [(best.dimension or "", top.member.label)]
    for dim in _drill_dims(view, used | {best.dimension or ""}, blocked)[:DRILL_DIMS]:
        if inv.calls >= MAX_CALLS:
            inv.stop = "budget"
            break
        use = measure_id
        if not _supports(vm, dim.id):
            alt = measures.get(vm.breakdown_measure or "")
            if alt is None or not _supports(alt, dim.id):
                continue
            use = alt.id
            inv.used_breakdown_measure = True
        step = safe(use, dim.id, drill_filters)
        if step is not None:
            inv.drill.append(step)
    if inv.drill:
        best_drill = max(inv.drill, key=lambda s: _top_share(s, s.total_delta))
        d_total = best_drill.total_delta
        if d_total != 0 and _top_share(best_drill, d_total) > 0:
            inv.drivers += _drivers_of(best_drill, d_total, 2, MAX_DRIVERS_L2, top.member.label)
    return inv
