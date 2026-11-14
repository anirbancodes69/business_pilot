"""LLM planner (E6.2 stage 5). One model call, plus at most one repair call (D-07).

The model drafts; code decides. Its reply is parsed strictly, checked against the authorized view,
and its relative dates are resolved by code. The result is a QueryPlan that the api still
re-authorizes. A model error or a plan that stays invalid after the repair becomes `failed`: it is
never guessed at or passed on.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from ai_engine.llm import LlmError, LlmProvider, LlmRequest
from ai_engine.planning.plan import RawPlan, parse_reply, to_query_plan, validate_against_view
from ai_engine.planning.prompts import (
    MAX_QUESTION_CHARS,
    PROMPT_VERSION,
    SYSTEM,
    build_prompt,
    build_repair_prompt,
)
from ai_engine.planning.time_resolver import TimeResolutionError
from ai_engine.planning.view import AuthorizedView


@dataclass
class PlannerOutcome:
    kind: Literal["plan", "clarify", "out_of_scope", "failed"]
    plan: dict[str, Any] | None = None
    clarification_question: str | None = None
    problems: list[str] = field(default_factory=list)
    # Problems found in the first reply when a repair call was needed (field paths, no user text).
    repaired_from: list[str] = field(default_factory=list)
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    prompt_version: str = PROMPT_VERSION
    raw_plan: RawPlan | None = None
    models: list[str] = field(default_factory=list)


def plan_question(
    question: str, view: AuthorizedView, now: datetime, provider: LlmProvider
) -> PlannerOutcome:
    text = question.strip()
    if not text:
        return PlannerOutcome(kind="clarify", clarification_question="What would you like to know?")
    if len(text) > MAX_QUESTION_CHARS:
        return PlannerOutcome(
            kind="clarify", clarification_question="Please ask a shorter, more specific question."
        )
    if not provider.is_real:
        return PlannerOutcome(kind="failed", problems=["no language model is configured"])
    if not view.measures:
        return PlannerOutcome(kind="out_of_scope")

    out = PlannerOutcome(kind="failed")
    prompt = build_prompt(text, view, now)
    for attempt in range(2):
        try:
            r = provider.complete(
                LlmRequest(
                    system=SYSTEM,
                    prompt=prompt,
                    role="planner",
                    json_output=True,
                    max_output_tokens=700,
                )
            )
        except LlmError as e:
            out.problems = [str(e)]
            return out
        out.llm_calls += 1
        if r.model not in out.models:
            out.models.append(r.model)
        out.input_tokens += r.input_tokens
        out.output_tokens += r.output_tokens

        reply, problems = parse_reply(r.text)
        if reply is not None:
            if reply.outcome == "out_of_scope":
                out.kind = "out_of_scope"
                return out
            if reply.outcome == "clarify":
                out.kind = "clarify"
                out.clarification_question = reply.clarification_question or "Could you clarify?"
                return out
            if reply.plan is None:
                problems = ["outcome plan needs a plan"]
            else:
                problems = validate_against_view(reply.plan, view)
                if not problems:
                    try:
                        out.plan = to_query_plan(reply.plan, view, now)
                    except TimeResolutionError as e:
                        problems = [f"time_range: {e}"]
                    else:
                        out.kind = "plan"
                        out.raw_plan = reply.plan
                        out.problems = []
                        return out
        out.problems = problems
        if attempt == 0:
            out.repaired_from = problems
            prompt = build_repair_prompt(build_prompt(text, view, now), problems)
    return out
