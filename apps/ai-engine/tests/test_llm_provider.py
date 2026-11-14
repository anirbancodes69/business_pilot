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


def _openai(handler: object) -> object:
    import httpx

    from ai_engine.llm.openai import OpenAiProvider

    return OpenAiProvider(
        api_key="sk-test-secret",
        models={"planner": "m-plan", "explainer": "m-explain"},
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


def test_openai_sends_the_right_request_and_reads_the_reply() -> None:
    import json

    import httpx

    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "m-explain-2026",
                "choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3},
            },
        )

    provider = _openai(handler)
    out = provider.complete(  # type: ignore[attr-defined]
        LlmRequest(system="s", prompt="p", role="explainer", json_output=True)
    )
    body = seen["body"]
    assert isinstance(body, dict)
    assert body["model"] == "m-explain"
    assert body["response_format"] == {"type": "json_object"}
    assert seen["auth"] == "Bearer sk-test-secret"
    assert (out.text, out.input_tokens, out.output_tokens) == ("{}", 11, 3)
    assert provider.is_real is True  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("status", "text"),
    [(401, "credentials"), (429, "rate limiting"), (500, "returned an error")],
)
def test_openai_errors_are_fixed_text_and_never_leak(status: int, text: str) -> None:
    import httpx

    from ai_engine.llm import LlmError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "key sk-test-secret prompt Asha"}})

    provider = _openai(handler)
    with pytest.raises(LlmError, match=text) as info:
        provider.complete(LlmRequest(system="s", prompt="Asha owes 5000"))  # type: ignore[attr-defined]
    assert "sk-test-secret" not in str(info.value) and "Asha" not in str(info.value)


def test_openai_truncated_or_malformed_replies_fail() -> None:
    import httpx

    from ai_engine.llm import LlmError

    cut = _openai(
        lambda r: httpx.Response(
            200, json={"choices": [{"message": {"content": "{"}, "finish_reason": "length"}]}
        )
    )
    with pytest.raises(LlmError):
        cut.complete(LlmRequest(system="s", prompt="p"))  # type: ignore[attr-defined]
    junk = _openai(lambda r: httpx.Response(200, json={"nope": 1}))
    with pytest.raises(LlmError):
        junk.complete(LlmRequest(system="s", prompt="p"))  # type: ignore[attr-defined]


def test_openai_needs_a_key_and_both_models() -> None:
    with pytest.raises(ValueError, match="needs LLM_API_KEY"):
        create_llm_provider("openai", Settings(llm_provider="openai"))
    ok = create_llm_provider(
        "openai",
        Settings(
            llm_provider="openai", llm_api_key="k", llm_model_planner="a", llm_model_explainer="b"
        ),
    )
    assert ok.is_real is True
