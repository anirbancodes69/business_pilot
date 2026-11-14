"""What the planner model may return, and its validation against the authorized view.

Validation here is a convenience that lets one repair attempt fix a mistake cheaply. It is not a
control: the api re-checks every plan against the user's real permissions and refuses what is not
allowed (CLAUDE.md rule 2).
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ai_engine.planning.time_resolver import (
    ComparisonType,
    TimeResolutionError,
    resolve_comparison,
    resolve_relative,
)
from ai_engine.planning.view import AuthorizedView

Operator = Literal["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between"]
Grain = Literal["day", "week", "month", "quarter", "fiscal_quarter", "year", "fiscal_year"]
Relative = Literal[
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "this_quarter",
    "last_quarter",
    "this_year",
    "last_year",
    "fiscal_ytd",
    "this_fiscal_year",
    "last_fiscal_year",
    "last_n_days",
    "last_n_months",
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RawTimeRange(_Strict):
    relative: Relative | None = None
    n: int | None = Field(default=None, ge=1, le=730)
    start: str | None = None
    end: str | None = None
    time_dimension: str | None = None


class RawDimension(_Strict):
    id: str
    time_grain: Grain | None = None


class RawFilter(_Strict):
    dimension: str
    operator: Operator
    values: list[str | int | float | bool] = Field(min_length=1, max_length=100)


class RawComparison(_Strict):
    type: Literal["previous_period", "same_period_last_year", "custom"]
    time_range: RawTimeRange | None = None


class RawSort(_Strict):
    by: str
    direction: Literal["asc", "desc"]


class RawPlan(_Strict):
    intent: Literal["metric", "ranking", "comparison", "trend", "diagnostic", "recommendation"]
    measures: list[str] = Field(min_length=1, max_length=5)
    dimensions: list[RawDimension] = Field(default_factory=list, max_length=3)
    filters: list[RawFilter] = Field(default_factory=list, max_length=10)
    time_range: RawTimeRange
    comparison: RawComparison | None = None
    sort: list[RawSort] = Field(default_factory=list, max_length=3)
    limit: int | None = Field(default=None, ge=1, le=100)
    rationale: str | None = Field(default=None, max_length=500)


class PlannerReply(_Strict):
    outcome: Literal["plan", "clarify", "out_of_scope", "attention"]
    plan: RawPlan | None = None
    period: RawTimeRange | None = None
    clarification_question: str | None = Field(default=None, max_length=300)


def parse_reply(text: str) -> tuple[PlannerReply | None, list[str]]:
    try:
        return PlannerReply.model_validate_json(text), []
    except ValidationError as e:
        # Field paths and messages only: never the model's text, which might echo user input.
        return None, [
            f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()
        ][:8]


def validate_against_view(plan: RawPlan, view: AuthorizedView) -> list[str]:
    problems: list[str] = []
    measures = {m.id: m for m in view.measures}
    dims = {d.id: d for d in view.dimensions}
    for mid in plan.measures:
        if mid not in measures:
            problems.append(f"unknown measure id: {mid}")
    chosen = [measures[m] for m in plan.measures if m in measures]
    if len({m.entity for m in chosen}) > 1:
        problems.append("measures of one plan must share an entity; ask for them separately")
    for ref in [d.id for d in plan.dimensions] + [f.dimension for f in plan.filters]:
        if ref not in dims:
            problems.append(f"unknown dimension id: {ref}")
        else:
            for m in chosen:
                if m.valid_dimensions is not None and ref not in m.valid_dimensions:
                    problems.append(f"dimension {ref} is not valid for measure {m.id}")
    for d in plan.dimensions:
        if d.time_grain and ref_type(dims, d.id) not in (None, "time"):
            problems.append(f"time_grain needs a time dimension: {d.id}")
    td = plan.time_range.time_dimension
    if td is not None and ref_type(dims, td) != "time":
        problems.append(f"time_dimension must be a time dimension: {td}")
    if td is None and chosen and not any(m.default_time_dimension for m in chosen):
        problems.append("no time dimension: name one in time_range.time_dimension")
    allowed_sort = set(plan.measures) | {d.id for d in plan.dimensions}
    for s in plan.sort:
        if s.by not in allowed_sort:
            problems.append(f"sort.by must be a measure or dimension of the plan: {s.by}")
    return problems


def ref_type(dims: dict[str, Any], dim_id: str) -> str | None:
    d = dims.get(dim_id)
    return None if d is None else str(d.type)


def _resolve(r: RawTimeRange, now: datetime, fiscal: int) -> dict[str, Any]:
    if r.relative is not None:
        start, end = resolve_relative(r.relative, r.n, now, fiscal)
    elif r.start and r.end:
        try:
            start, end = (
                datetime.fromisoformat(r.start).date(),
                datetime.fromisoformat(r.end).date(),
            )
        except ValueError as e:
            raise TimeResolutionError("invalid date") from e
        if start > end:
            raise TimeResolutionError("the range ends before it starts")
    else:
        raise TimeResolutionError("a time range needs a relative token or start and end")
    out: dict[str, Any] = {"start": start.isoformat(), "end": end.isoformat()}
    if r.time_dimension:
        out["time_dimension"] = r.time_dimension
    return out


def resolve_period(raw: RawTimeRange | None, view: AuthorizedView, now: datetime) -> dict[str, Any]:
    """The period of an attention question as absolute dates (this week so far, by default)."""
    return _resolve(
        raw or RawTimeRange(relative="this_week"), now, view.tenant_settings.fiscal_year_start_month
    )


def to_query_plan(plan: RawPlan, view: AuthorizedView, now: datetime) -> dict[str, Any]:
    """The absolute-dated QueryPlan of contracts/ai/query-plan.schema.json (version 0.1)."""
    fiscal = view.tenant_settings.fiscal_year_start_month
    current = _resolve(plan.time_range, now, fiscal)
    out: dict[str, Any] = {
        "plan_version": "0.1",
        "semantic_model_version": view.semantic_model_version,
        "intent": plan.intent,
        "measures": sorted(set(plan.measures)),
        "time_range": current,
    }
    if plan.dimensions:
        out["dimensions"] = [d.model_dump(exclude_none=True) for d in plan.dimensions]
    if plan.filters:
        out["filters"] = [
            {**f.model_dump(), "values": sorted(f.values, key=str)} for f in plan.filters
        ]
    if plan.comparison:
        c = plan.comparison
        if c.type == "custom":
            if c.time_range is None:
                raise TimeResolutionError("a custom comparison needs a time range")
            comp = _resolve(c.time_range, now, fiscal)
        else:
            kind: ComparisonType = c.type
            s, e = resolve_comparison(
                kind, (date.fromisoformat(current["start"]), date.fromisoformat(current["end"]))
            )
            comp = {"start": s.isoformat(), "end": e.isoformat()}
            if "time_dimension" in current:
                comp["time_dimension"] = current["time_dimension"]
        out["comparison"] = {"type": c.type, "time_range": comp}
    if plan.sort:
        out["sort"] = [s.model_dump() for s in plan.sort]
    if plan.limit:
        out["limit"] = plan.limit
    return out
