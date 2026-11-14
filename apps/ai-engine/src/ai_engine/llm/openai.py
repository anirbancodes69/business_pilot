"""OpenAI adapter for the LlmProvider port (ADR-0019).

Calls the Chat Completions API over HTTPS. The prompt, the reply and the key are never logged and
never appear in an error: every failure becomes a fixed-text `LlmError`. Nothing is retried here;
the orchestrator decides what a failure means.
"""

from collections.abc import Mapping
from typing import Any

import httpx

from ai_engine.llm.provider import LlmError, LlmRequest, LlmResponse


class OpenAiProvider:
    is_real = True

    def __init__(
        self,
        api_key: str,
        models: Mapping[str, str],
        base_url: str = "https://api.openai.com/v1",
        timeout_seconds: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._models = dict(models)
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
            transport=transport,
        )

    def complete(self, request: LlmRequest) -> LlmResponse:
        model = self._models[request.role]
        body: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.prompt},
            ],
            "max_completion_tokens": request.max_output_tokens,
        }
        if request.json_output:
            body["response_format"] = {"type": "json_object"}
        try:
            r = self._client.post("/chat/completions", json=body)
        except httpx.TimeoutException:
            raise LlmError("the model call timed out") from None
        except httpx.HTTPError:
            raise LlmError("the model could not be reached") from None
        if r.status_code == 429:
            raise LlmError("the model provider is rate limiting requests")
        if r.status_code in (401, 403):
            raise LlmError("the model provider refused the credentials")
        if r.status_code >= 400:
            raise LlmError("the model provider returned an error")
        try:
            data = r.json()
            choice = data["choices"][0]
            text = choice["message"]["content"]
            usage = data.get("usage", {})
            if not isinstance(text, str) or choice.get("finish_reason") == "length":
                raise LlmError("the model reply was empty or cut off")
            return LlmResponse(
                text=text,
                model=str(data.get("model", model)),
                input_tokens=int(usage.get("prompt_tokens", 0)),
                output_tokens=int(usage.get("completion_tokens", 0)),
            )
        except LlmError:
            raise
        except (ValueError, KeyError, IndexError, TypeError):
            raise LlmError("the model reply could not be read") from None
