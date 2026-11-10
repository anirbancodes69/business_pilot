from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from ai_engine.request_id import REQUEST_ID_HEADER, request_id_var, resolve_request_id
from ai_engine.settings import Settings
from ai_engine.telemetry import build_tracer_provider, set_global_provider


def create_app(
    settings: Settings | None = None, tracer_provider: TracerProvider | None = None
) -> FastAPI:
    settings = settings or Settings()
    provider = tracer_provider or build_tracer_provider(settings)
    if tracer_provider is None:
        set_global_provider(provider)

    app = FastAPI(title="BusinessPilot AI engine", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def request_id_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = resolve_request_id(request.headers.get(REQUEST_ID_HEADER))
        token = request_id_var.set(request_id)
        trace.get_current_span().set_attribute("request_id", request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    return app


app = create_app()
