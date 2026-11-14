"""Stand-ins for the model and the api. They make no network call and cost nothing."""

import json
from collections.abc import Callable
from typing import Any

from ai_engine.answer.models import ToolResult
from ai_engine.answer.tools import ToolError, ToolFailure
from ai_engine.llm import LlmRequest, LlmResponse

Reply = str | dict[str, Any] | Exception | Callable[[LlmRequest], dict[str, Any]]


class Scripted:
    """Replays replies in order and records every request."""

    is_real = True

    def __init__(self, *replies: Reply) -> None:
        self.replies = list(replies)
        self.requests: list[LlmRequest] = []

    def complete(self, request: LlmRequest) -> LlmResponse:
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(request)
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return LlmResponse(text=text, model="scripted", input_tokens=100, output_tokens=20)


class FakeTools:
    def __init__(self, result: ToolResult | ToolFailure) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    def execute_plan(
        self, request_context: str, request_id: str, plan: dict[str, Any]
    ) -> ToolResult:
        self.calls.append(
            {"request_context": request_context, "request_id": request_id, "plan": plan}
        )
        if isinstance(self.result, str):
            raise ToolError(self.result)
        return self.result


def data_refs(request: LlmRequest) -> list[dict[str, Any]]:
    """The result sets the explainer was shown (numbers as evidence ids)."""
    body = request.prompt.split("<data>")[1].split("</data>")[0]
    sets: list[dict[str, Any]] = json.loads(body)["result_sets"]
    return sets


def tool_result(
    rows: list[list[Any]],
    dimension: bool = True,
    measure: str = "outstanding_receivables",
    unit: str = "currency",
    comparison_rows: list[list[Any]] | None = None,
) -> ToolResult:
    cols: list[dict[str, Any]] = []
    if dimension:
        cols.append(
            {
                "name": "d0",
                "semantic_id": "customer.name",
                "kind": "dimension",
                "type": "categorical",
            }
        )
    cols.append(
        {"name": "m0", "semantic_id": measure, "kind": "measure", "type": "numeric", "unit": unit}
    )
    sets = [
        {
            "id": "abc123-current",
            "role": "current",
            "columns": cols,
            "rows": rows,
            "row_count": len(rows),
            "truncated": False,
        }
    ]
    if comparison_rows is not None:
        sets.append(
            {
                "id": "abc123-comparison",
                "role": "comparison",
                "columns": cols,
                "rows": comparison_rows,
                "row_count": len(comparison_rows),
                "truncated": False,
            }
        )
    return ToolResult.model_validate(
        {
            "plan_hash": "ph" * 32,
            "semantic_model_version": 3,
            "data_executed_at": "2026-11-15T04:30:00Z",
            "result_sets": sets,
        }
    )
