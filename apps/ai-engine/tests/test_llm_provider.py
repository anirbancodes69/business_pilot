import pytest

from ai_engine.llm import DummyLlmProvider, LlmRequest, create_llm_provider
from ai_engine.settings import Settings


def test_dummy_is_the_default_and_not_real() -> None:
    provider = create_llm_provider(Settings().llm_provider)
    assert isinstance(provider, DummyLlmProvider)
    assert provider.is_real is False


def test_dummy_ignores_the_prompt() -> None:
    provider = create_llm_provider("dummy")
    first = provider.complete(LlmRequest(system="s", prompt="customer Asha owes 5000"))
    second = provider.complete(LlmRequest(system="other", prompt="anything"))
    assert first == second
    assert first.model == "dummy"
    assert first.input_tokens == 0
    assert "Asha" not in first.text


def test_unknown_provider_fails_closed() -> None:
    with pytest.raises(ValueError, match="unsupported"):
        create_llm_provider("not-a-provider")
