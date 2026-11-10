from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from ai_engine.main import create_app
from ai_engine.settings import Settings


def make_client() -> tuple[TestClient, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    app = create_app(Settings(otel_traces_exporter="none"), tracer_provider=provider)
    return TestClient(app), exporter


def test_health_ok() -> None:
    client, _ = make_client()
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_request_id_echoed_and_generated() -> None:
    client, _ = make_client()
    assert (
        client.get("/health", headers={"x-request-id": "req-12345678"}).headers["x-request-id"]
        == "req-12345678"
    )
    generated = client.get("/health", headers={"x-request-id": "bad id!"}).headers["x-request-id"]
    assert generated != "bad id!"
    assert len(generated) == 36


def test_trace_continues_from_traceparent_and_carries_request_id() -> None:
    client, exporter = make_client()
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    client.get(
        "/health",
        headers={
            "traceparent": f"00-{trace_id}-b7ad6b7169203331-01",
            "x-request-id": "req-12345678",
        },
    )
    server_spans = [s for s in exporter.get_finished_spans() if s.attributes]
    assert server_spans
    span = next(s for s in server_spans if s.attributes and "request_id" in s.attributes)
    assert format(span.context.trace_id, "032x") == trace_id
    assert span.attributes is not None
    assert span.attributes["request_id"] == "req-12345678"
