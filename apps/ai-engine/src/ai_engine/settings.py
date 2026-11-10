from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    otel_service_name: str = "bp-ai-engine"
    otel_traces_exporter: str = "otlp"  # otlp | console | none
