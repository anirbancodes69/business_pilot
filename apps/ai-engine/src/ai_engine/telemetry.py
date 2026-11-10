from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
)

from ai_engine.settings import Settings


def build_tracer_provider(settings: Settings) -> TracerProvider:
    """Build the provider. W3C trace context is the default propagator, so a traceparent
    header sent by the api continues the same trace. Span attributes must not contain
    credentials, result rows or tenant prompt content."""
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: settings.otel_service_name}))
    if settings.otel_traces_exporter == "console":
        provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
    elif settings.otel_traces_exporter != "none":
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    return provider


def set_global_provider(provider: TracerProvider) -> None:
    trace.set_tracer_provider(provider)
