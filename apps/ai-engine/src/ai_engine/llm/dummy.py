from ai_engine.llm.provider import LlmRequest, LlmResponse


class DummyLlmProvider:
    """Stand-in for a language model (ADR-0015). Calls nothing and reads nothing.

    It returns the same fixed text for every request, so it can never be mistaken for an answer.
    The prompt is not logged or stored.
    """

    is_real = False
    model = "dummy"
    TEXT = "[dummy llm: no model is configured]"

    def complete(self, request: LlmRequest) -> LlmResponse:
        return LlmResponse(
            text=self.TEXT,
            model=self.model,
            input_tokens=0,
            output_tokens=0,
        )
