import hmac
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, Response
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from ai_engine.answer.flow import answer_question
from ai_engine.answer.models import AnswerRequest
from ai_engine.answer.tools import ApiTools, DataTools
from ai_engine.llm import LlmProvider, create_llm_provider
from ai_engine.request_id import REQUEST_ID_HEADER, request_id_var, resolve_request_id
from ai_engine.settings import Settings
from ai_engine.telemetry import build_tracer_provider, set_global_provider


def create_app(
    settings: Settings | None = None,
    tracer_provider: TracerProvider | None = None,
    llm: LlmProvider | None = None,
    tools: DataTools | None = None,
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

    def require_service_token(authorization: str | None) -> None:
        # Fail closed: without a configured token nobody may call /internal/*.
        expected = settings.internal_service_token or ""
        given = (authorization or "").removeprefix("Bearer ")
        if len(expected) < 16 or not hmac.compare_digest(expected.encode(), given.encode()):
            raise HTTPException(status_code=401)

    @app.post("/internal/v1/answer")
    def answer(
        body: AnswerRequest, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        require_service_token(authorization)
        provider = llm or create_llm_provider(settings.llm_provider, settings)
        data_tools = tools or ApiTools(settings.api_base_url, settings.internal_service_token or "")
        request_id = request_id_var.get() or str(uuid.uuid4())
        result = answer_question(body, request_id, provider, data_tools)
        return result.model_dump(mode="json", exclude_none=True)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    return app


app = create_app()
