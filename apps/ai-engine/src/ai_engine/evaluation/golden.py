"""The golden set and the plan matcher. Pure: no model, no network."""

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

EVAL_DIR = Path(__file__).resolve().parents[3] / "evaluation"


class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Case(_Loose):
    id: str
    category: str
    status: Literal["active", "pending"] = "active"
    persona: str = "owner"
    question: str | None = None
    expected: Literal["plan", "clarify", "out_of_scope", "followup"] = "plan"
    planner_expected: Literal["plan", "no_plan"] = "plan"
    expected_intent: str | None = None
    expected_plan: dict[str, Any] | None = None
    # Other plans that are equally correct (for example a customer's city instead of a branch).
    accepted_alternatives: list[dict[str, Any]] = []
    # Outcomes other than a plan that count as correct (for example asking to clarify).
    accepted_outcomes: list[str] = []
    needs: str | None = None
    turns: list[dict[str, Any]] | None = None


class Suite(_Loose):
    suite: str
    as_of: str
    cases: list[Case]


def load_suite(path: Path | None = None) -> Suite:
    p = path or EVAL_DIR / "golden" / "wholesale_v0.json"
    return Suite.model_validate(json.loads(p.read_text(encoding="utf-8")))


def load_view(persona: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (EVAL_DIR / "fixtures" / f"view_{persona}.json").read_text(encoding="utf-8")
    )
    return data


def _filters(items: list[dict[str, Any]] | None) -> set[tuple[str, str, tuple[str, ...]]]:
    out: set[tuple[str, str, tuple[str, ...]]] = set()
    for f in items or []:
        op = "eq" if f["operator"] == "in" and len(f["values"]) == 1 else f["operator"]
        out.add((f["dimension"], op, tuple(sorted(str(v) for v in f["values"]))))
    return out


def match_plan(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """Differences between an expected and an actual plan, as short messages (empty = match).

    Only what the case states is compared: a case without `time_range` accepts any period, one
    without `sort` accepts any order. Dates are absolute on both sides.
    """
    problems: list[str] = []
    if set(expected["measures"]) != set(actual.get("measures", [])):
        problems.append(
            f"measures: wanted {sorted(expected['measures'])}, got {actual.get('measures')}"
        )
    want_dims = {d["id"]: d.get("time_grain") for d in expected.get("dimensions", [])}
    got_dims = {d["id"]: d.get("time_grain") for d in actual.get("dimensions", [])}
    if set(want_dims) != set(got_dims):
        problems.append(f"dimensions: wanted {sorted(want_dims)}, got {sorted(got_dims)}")
    else:
        for dim, grain in want_dims.items():
            if grain and got_dims[dim] != grain:
                problems.append(f"time_grain of {dim}: wanted {grain}, got {got_dims[dim]}")
    if _filters(expected.get("filters")) != _filters(actual.get("filters")):
        problems.append("filters differ")
    want_range = expected.get("time_range")
    if want_range:
        got = actual.get("time_range", {})
        if (want_range["start"], want_range["end"]) != (got.get("start"), got.get("end")):
            problems.append(
                f"time_range: wanted {want_range['start']}..{want_range['end']}, "
                f"got {got.get('start')}..{got.get('end')}"
            )
    want_cmp = expected.get("comparison")
    if want_cmp:
        got_cmp = (actual.get("comparison") or {}).get("time_range", {})
        if (want_cmp["start"], want_cmp["end"]) != (got_cmp.get("start"), got_cmp.get("end")):
            problems.append("comparison period differs")
    want_sort = expected.get("sort")
    if want_sort:
        got_sort = (actual.get("sort") or [{}])[0]
        if (want_sort["by"], want_sort["direction"]) != (
            got_sort.get("by"),
            got_sort.get("direction"),
        ):
            problems.append("sort differs")
    if expected.get("limit") and expected["limit"] != actual.get("limit"):
        problems.append(f"limit: wanted {expected['limit']}, got {actual.get('limit')}")
    return problems


def match_delta(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """Differences between the expected and the understood follow-up change. Only what the case
    states is compared (a case that names no `mode` accepts either)."""
    problems: list[str] = []
    for key, want in expected.items():
        if key == "time_range":
            continue  # the period is checked through the resulting plan, whatever form it took
        got = actual.get(key)
        if key in ("values", "measures"):
            same = set(map(str, want)) == set(map(str, got or []))
        elif key == "dimensions":
            same = [d["id"] for d in want] == [d["id"] for d in got or []]
        else:
            same = want == got
        if not same:
            problems.append(f"delta {key}: wanted {want}, got {got}")
    return problems


class CaseResult(BaseModel):
    id: str
    category: str
    outcome: str
    ok: bool
    intent_ok: bool | None = None
    problems: list[str] = []
    # Diagnostics for tuning: why the first reply needed a repair, and the plan that was produced.
    repaired_from: list[str] = []
    # The clarifying question the system asked, when it asked one (user-facing text).
    clarification: str | None = None
    actual_plan: dict[str, Any] | None = None
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


class Summary(BaseModel):
    total: int
    passed: int
    pending: int
    by_category: dict[str, tuple[int, int]]
    plan_accuracy: float | None
    intent_accuracy: float | None
    input_tokens: int
    output_tokens: int
    llm_calls: int


def summarize(results: list[CaseResult], pending: int) -> Summary:
    cats: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for r in results:
        cats[r.category][1] += 1
        cats[r.category][0] += int(r.ok)
    intents = [r.intent_ok for r in results if r.intent_ok is not None]
    return Summary(
        total=len(results),
        passed=sum(r.ok for r in results),
        pending=pending,
        by_category={k: (v[0], v[1]) for k, v in sorted(cats.items())},
        plan_accuracy=(sum(r.ok for r in results) / len(results)) if results else None,
        intent_accuracy=(sum(intents) / len(intents)) if intents else None,
        input_tokens=sum(r.input_tokens for r in results),
        output_tokens=sum(r.output_tokens for r in results),
        llm_calls=sum(r.llm_calls for r in results),
    )
