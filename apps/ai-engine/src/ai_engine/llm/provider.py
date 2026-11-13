"""LLM provider port (ADR-0015, D-OPEN-01).

Product code depends on `LlmProvider` only. No real provider is chosen yet, so the dummy provider
is the only implementation. Callers must check `is_real` and fall back to deterministic logic
(for example name-similarity mapping suggestions) when it is False.
"""

from typing import Protocol

from pydantic import BaseModel, ConfigDict


class LlmRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    system: str
    prompt: str
    max_output_tokens: int = 1024


class LlmResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    text: str
    model: str
    input_tokens: int
    output_tokens: int


class LlmProvider(Protocol):
    @property
    def is_real(self) -> bool:
        """False for a stand-in that does not call a model."""
        ...

    def complete(self, request: LlmRequest) -> LlmResponse: ...


def create_llm_provider(name: str) -> LlmProvider:
    """The only place that picks a provider. Unknown names fail closed."""
    if name == "dummy":
        from ai_engine.llm.dummy import DummyLlmProvider

        return DummyLlmProvider()
    raise ValueError("unsupported LLM provider")
