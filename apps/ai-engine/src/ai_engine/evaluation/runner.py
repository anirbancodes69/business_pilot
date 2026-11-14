"""Runs the planner over the golden set. The only code in the repository that can spend money on
purpose: real calls need `--real --yes` on the command line (see __main__)."""

import json
from datetime import datetime
from typing import Any

from ai_engine.answer.context import build_context
from ai_engine.evaluation.golden import (
    Case,
    CaseResult,
    Suite,
    load_view,
    match_delta,
    match_plan,
)
from ai_engine.llm import LlmProvider, LlmRequest, LlmResponse
from ai_engine.planning.followup import plan_follow_up
from ai_engine.planning.planner import plan_question
from ai_engine.planning.view import AuthorizedView


def plan_reply(expected: dict[str, Any], intent: str | None) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "intent": intent or "metric",
        "measures": expected["measures"],
        "dimensions": expected.get("dimensions", []),
        "filters": expected.get("filters", []),
        "time_range": expected.get("time_range") or {"start": "2024-11-16", "end": "2026-11-15"},
        "sort": [expected["sort"]] if expected.get("sort") else [],
    }
    if expected.get("comparison"):
        plan["comparison"] = {"type": "custom", "time_range": expected["comparison"]}
    if expected.get("limit"):
        plan["limit"] = expected["limit"]
    return {"outcome": "plan", "plan": plan}


class ReplayProvider:
    """Answers each question with the case's own expected plan (or expected follow-up change).
    Costs nothing.

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
        if "classify a follow-up" in request.system:
            second = (c.turns or [{}, {}])[1]
            return self._reply({"delta": second["expected_delta"]})
        if c.expected == "followup":
            first = (c.turns or [{}])[0]
            return self._reply(plan_reply(first["expected_plan"], first.get("expected_intent")))
        if c.expected == "attention":
            reply: dict[str, Any] = {"outcome": "attention", "period": {"relative": "this_week"}}
        elif c.expected == "clarify":
            reply = {"outcome": "clarify", "clarification_question": "Which period?"}
        elif c.expected == "out_of_scope" or c.planner_expected == "no_plan":
            reply = {"outcome": "out_of_scope"}
        else:
            reply = plan_reply(c.expected_plan or {}, c.expected_intent)
        return self._reply(reply)

    @staticmethod
    def _reply(reply: dict[str, Any]) -> LlmResponse:
        return LlmResponse(text=json.dumps(reply), model="replay", input_tokens=0, output_tokens=0)


def evaluate_followup(case: Case, now: datetime, provider: LlmProvider) -> CaseResult:
    """Two turns: plan the first question, then understand the follow-up as a typed change."""
    view = AuthorizedView.model_validate(load_view(case.persona))
    first, second = (case.turns or [{}, {}])[:2]
    problems: list[str] = []
    o1 = plan_question(first["question"], view, now, provider)
    result = CaseResult(
        id=case.id,
        category=case.category,
        outcome=o1.kind,
        ok=False,
        llm_calls=o1.llm_calls,
        input_tokens=o1.input_tokens,
        output_tokens=o1.output_tokens,
    )
    if o1.kind != "plan":
        result.problems = [f"turn 1: wanted a plan, got {o1.kind}"]
        result.clarification = o1.clarification_question
        return result
    if match := match_plan(first["expected_plan"], o1.plan or {}):
        problems += [f"turn 1: {m}" for m in match]
    context = build_context(o1, view.semantic_model_version, None, [])
    follow, spent = plan_follow_up(second["question"], view, now, provider, context)
    result.llm_calls += spent.calls
    result.input_tokens += spent.input_tokens
    result.output_tokens += spent.output_tokens
    want = second["expected_delta"]
    if want["type"] == "new_question":
        if follow is not None:
            problems.append(f"turn 2: wanted a new question, got {follow.delta}")
        result.outcome = "new_question" if follow is None else follow.kind
    elif follow is None or follow.kind != "plan":
        problems.append(f"turn 2: wanted a follow-up plan, got {follow.kind if follow else 'none'}")
        result.outcome = follow.kind if follow else "none"
    else:
        result.outcome = "plan"
        problems += match_delta(want, follow.delta or {})
        if second.get("expected_plan"):
            problems += [
                f"turn 2: {m}" for m in match_plan(second["expected_plan"], follow.plan or {})
            ]
    result.problems = problems
    result.ok = not problems
    return result


def evaluate_case(case: Case, now: datetime, provider: LlmProvider) -> CaseResult:
    if case.expected == "followup":
        if isinstance(provider, ReplayProvider):
            provider.case = case
        return evaluate_followup(case, now, provider)
    view = AuthorizedView.model_validate(load_view(case.persona))
    if isinstance(provider, ReplayProvider):
        provider.case = case
    out = plan_question(case.question or "", view, now, provider)
    problems: list[str] = []
    if case.expected == "attention":
        ok = out.kind == "attention"
        intent_ok = None
        problems = [] if ok else [f"wanted an attention briefing, got {out.kind}"]
    elif case.planner_expected == "no_plan" or case.expected in ("clarify", "out_of_scope"):
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
        if not ok and out.kind in case.accepted_outcomes:
            ok = True
        elif not ok:
            problems.append(f"wanted a plan, got {out.kind}: {'; '.join(out.problems)[:200]}")
        elif case.expected_plan is not None and out.plan is not None:
            problems = match_plan(case.expected_plan, out.plan)
            for alt in case.accepted_alternatives:
                if problems and not match_plan({**case.expected_plan, **alt}, out.plan):
                    problems = []
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
        repaired_from=out.repaired_from,
        clarification=out.clarification_question,
        actual_plan=out.plan if not ok or out.repaired_from else None,
        llm_calls=out.llm_calls,
        input_tokens=out.input_tokens,
        output_tokens=out.output_tokens,
    )


def run(
    suite: Suite,
    provider: LlmProvider,
    only: set[str] | None = None,
    limit: int | None = None,
    max_tokens: int | None = None,
) -> tuple[list[CaseResult], int]:
    now = datetime.fromisoformat(suite.as_of)
    active = [c for c in suite.cases if c.status == "active" and (not only or c.id in only)]
    if limit is not None:
        active = active[:limit]
    pending = sum(c.status == "pending" for c in suite.cases)
    results: list[CaseResult] = []
    spent = 0
    for c in active:
        # A hard stop on spending: no new case starts once the budget is used up.
        if max_tokens is not None and spent >= max_tokens:
            break
        r = evaluate_case(c, now, provider)
        spent += r.input_tokens + r.output_tokens
        results.append(r)
    return results, pending
