import pytest


@pytest.fixture(autouse=True)
def no_real_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never reach a real model: a developer's real key must not leak into a test run."""
    for name in ("LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_PLANNER", "LLM_MODEL_EXPLAINER"):
        monkeypatch.delenv(name, raising=False)
