"""The AnalyticalContext carried between turns (D-21, ADR-0011).

Semantic ids, filter values, relative time tokens, grains, sort, limit and evidence references only:
no rows, no figures and no question text. It is never a source of authority: the api re-validates
it against the user's current authorized view before it is sent back here.
"""

from typing import Any

from ai_engine.planning.planner import PlannerOutcome


def build_context(
    outcome: PlannerOutcome, model_version: int, previous_turn: object, refs: list[str]
) -> dict[str, Any]:
    raw = outcome.raw_plan
    focus: dict[str, Any] = {}
    if raw is not None:
        focus = {
            "metrics": raw.measures,
            "dimensions": [d.id for d in raw.dimensions],
            "filters": [f.model_dump() for f in raw.filters],
            "time_range": raw.time_range.model_dump(exclude_none=True),
        }
        grains = {d.id: d.time_grain for d in raw.dimensions if d.time_grain}
        if grains:
            focus["time_grains"] = grains
        if raw.sort:
            focus["sort"] = [s.model_dump() for s in raw.sort]
        if raw.limit:
            focus["limit"] = raw.limit
        if raw.comparison:
            focus["comparison"] = raw.comparison.model_dump(exclude_none=True)
    ctx: dict[str, Any] = {
        "semantic_model_version": model_version,
        "turn": previous_turn + 1 if isinstance(previous_turn, int) else 1,
        "last_analysis_type": raw.intent if raw else "clarify",
        "open_hypotheses": [],
        "evidence_refs": refs[:50],
    }
    if focus:
        ctx["focus"] = focus
    return ctx
