"""Client for the api's internal tool endpoints (contracts/ai/README.md). The only way ai-engine
reaches data (CLAUDE.md rule 3). Failures are mapped to fixed kinds; bodies are never kept."""

from typing import Any, Literal, Protocol

import httpx

from ai_engine.answer.models import ToolResult

ToolFailure = Literal["not_authorized", "invalid_plan", "timeout", "rate_limited", "failed"]


class ToolError(Exception):
    def __init__(self, kind: ToolFailure) -> None:
        super().__init__(kind)
        self.kind = kind


class DataTools(Protocol):
    def execute_plan(
        self, request_context: str, request_id: str, plan: dict[str, Any]
    ) -> ToolResult: ...


class ApiTools:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        transport: httpx.BaseTransport | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {service_token}"},
            timeout=timeout_seconds,
            transport=transport,
        )

    def execute_plan(
        self, request_context: str, request_id: str, plan: dict[str, Any]
    ) -> ToolResult:
        try:
            r = self._client.post(
                "/internal/v1/tools/execute-plan",
                json={"request_context": request_context, "plan": plan},
                headers={"x-request-id": request_id},
            )
        except httpx.TimeoutException:
            raise ToolError("timeout") from None
        except httpx.HTTPError:
            raise ToolError("failed") from None
        kinds: dict[int, ToolFailure] = {
            403: "not_authorized",
            422: "invalid_plan",
            429: "rate_limited",
            504: "timeout",
        }
        if r.status_code != 200:
            raise ToolError(kinds.get(r.status_code, "failed"))
        try:
            return ToolResult.model_validate(r.json())
        except ValueError:
            raise ToolError("failed") from None
