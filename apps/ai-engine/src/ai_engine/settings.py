from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    otel_service_name: str = "bp-ai-engine"
    otel_traces_exporter: str = "otlp"  # otlp | console | none
    llm_provider: str = "dummy"  # dummy | openai (ADR-0019)
    llm_api_key: str | None = None  # never logged
    llm_model_planner: str | None = None
    llm_model_explainer: str | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_timeout_seconds: float = 30.0
