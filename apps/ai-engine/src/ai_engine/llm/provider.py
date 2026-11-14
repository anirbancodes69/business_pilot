"""LLM provider port (ADR-0015, D-OPEN-01).

Product code depends on `LlmProvider` only. No real provider is chosen yet, so the dummy provider
is the only implementation. Callers must check `is_real` and fall back to deterministic logic
(for example name-similarity mapping suggestions) when it is False.
"""

from typing import TYPE_CHECKING, Literal, Protocol

from pydantic import BaseModel, ConfigDict

if TYPE_CHECKING:
    from ai_engine.settings import Settings


class LlmRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    system: str
    prompt: str
    max_output_tokens: int = 1024
    # Which model slot to use (LLM_MODEL_PLANNER or LLM_MODEL_EXPLAINER) and whether the reply must
    # be one JSON object. The dummy provider ignores both.
    role: Literal["planner", "explainer"] = "planner"
    json_output: bool = False


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


class LlmError(Exception):
    """A model call failed. The message is fixed text: never the prompt, the reply or a key."""


def create_llm_provider(name: str, settings: "Settings | None" = None) -> LlmProvider:
    """The only place that picks a provider. Unknown names fail closed."""
    if name == "dummy":
        from ai_engine.llm.dummy import DummyLlmProvider

        return DummyLlmProvider()
    if name == "openai":
        from ai_engine.llm.openai import OpenAiProvider
        from ai_engine.settings import Settings

        s = settings or Settings()
        if not s.llm_api_key or not s.llm_model_planner or not s.llm_model_explainer:
            raise ValueError("openai needs LLM_API_KEY, LLM_MODEL_PLANNER and LLM_MODEL_EXPLAINER")
        return OpenAiProvider(
            api_key=s.llm_api_key,
            models={"planner": s.llm_model_planner, "explainer": s.llm_model_explainer},
            base_url=s.llm_base_url,
            timeout_seconds=s.llm_timeout_seconds,
        )
    raise ValueError("unsupported LLM provider")
