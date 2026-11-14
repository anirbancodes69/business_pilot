"""Runs the planner over the golden set. The only code in the repository that can spend money on
purpose: real calls need `--real --yes` on the command line (see __main__)."""

import json
from datetime import datetime
from typing import Any

from ai_engine.evaluation.golden import (
    Case,
    CaseResult,
    Suite,
    load_view,
    match_plan,
)
from ai_engine.llm import LlmProvider, LlmRequest, LlmResponse
from ai_engine.planning.planner import plan_question
from ai_engine.planning.view import AuthorizedView


class ReplayProvider:
    """Answers each question with the case's own expected plan. Costs nothing.

    It checks the golden set and the harness, not a model: every expected plan must be valid for the
    persona's authorized view and must come back unchanged through the planner's validation.
    """

    is_real = True  # the planner refuses a non-real provider; this one is a deliberate stand-in

    def __init__(self) -> None:
        self.case: Case | None = None

    def complete(self, request: LlmRequest) -> LlmResponse:
        c = self.case
        if c is None:
            raise RuntimeError("no case is set")
        if c.expected == "clarify":
            reply: dict[str, Any] = {
                "outcome": "clarify",
                "clarification_question": "Which period?",
            }
        elif c.expected == "out_of_scope" or c.planner_expected == "no_plan":
            reply = {"outcome": "out_of_scope"}
        else:
            e = c.expected_plan or {}
            plan: dict[str, Any] = {
                "intent": c.expected_intent or "metric",
                "measures": e["measures"],
                "dimensions": e.get("dimensions", []),
                "filters": e.get("filters", []),
                "time_range": e.get("time_range") or {"start": "2024-11-16", "end": "2026-11-15"},
                "sort": [e["sort"]] if e.get("sort") else [],
            }
            if e.get("comparison"):
                plan["comparison"] = {"type": "custom", "time_range": e["comparison"]}
            if e.get("limit"):
                plan["limit"] = e["limit"]
            reply = {"outcome": "plan", "plan": plan}
        return LlmResponse(text=json.dumps(reply), model="replay", input_tokens=0, output_tokens=0)


def evaluate_case(case: Case, now: datetime, provider: LlmProvider) -> CaseResult:
    view = AuthorizedView.model_validate(load_view(case.persona))
    if isinstance(provider, ReplayProvider):
        provider.case = case
    out = plan_question(case.question or "", view, now, provider)
    problems: list[str] = []
    if case.planner_expected == "no_plan" or case.expected in ("clarify", "out_of_scope"):
        # A case that names its refusal must get exactly that; a persona that simply cannot see the
        # data (planner_expected = no_plan) may be refused or asked to clarify, never given a plan.
        want = case.expected if case.expected != "plan" else None
        ok = out.kind in ({"clarify", "out_of_scope", "failed"} if want is None else {want})
        if not ok:
            problems.append(f"wanted no plan ({want or 'refusal'}), got {out.kind}")
        intent_ok = None
    else:
        ok = out.kind == "plan" and out.plan is not None
        intent_ok = None
        if not ok:
            problems.append(f"wanted a plan, got {out.kind}: {'; '.join(out.problems)[:200]}")
        elif case.expected_plan is not None and out.plan is not None:
            problems = match_plan(case.expected_plan, out.plan)
            ok = not problems
            if case.expected_intent:
                intent_ok = out.plan.get("intent") == case.expected_intent
    return CaseResult(
        id=case.id,
        category=case.category,
        outcome=out.kind,
        ok=ok,
        intent_ok=intent_ok,
        problems=problems,
        llm_calls=out.llm_calls,
        input_tokens=out.input_tokens,
        output_tokens=out.output_tokens,
    )


def run(
    suite: Suite,
    provider: LlmProvider,
    only: set[str] | None = None,
    limit: int | None = None,
) -> tuple[list[CaseResult], int]:
    now = datetime.fromisoformat(suite.as_of)
    active = [c for c in suite.cases if c.status == "active" and (not only or c.id in only)]
    if limit is not None:
        active = active[:limit]
    pending = sum(c.status == "pending" for c in suite.cases)
    return [evaluate_case(c, now, provider) for c in active], pending
