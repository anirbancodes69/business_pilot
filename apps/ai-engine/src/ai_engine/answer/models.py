"""Models for /internal/v1/answer (contracts/ai/answer-response.schema.json)."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ai_engine.planning.view import AuthorizedView


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_context: str = Field(min_length=1)
    question: str = Field(max_length=4000)
    analytical_context: dict[str, Any] | None = None
    authorized_view: AuthorizedView
    resolved_now: datetime
    locale: str = "en-IN"


class ToolColumn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    semantic_id: str
    kind: Literal["dimension", "measure"]
    type: str
    unit: str | None = None


class ToolResultSet(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    role: Literal["current", "comparison"]
    columns: list[ToolColumn]
    rows: list[list[Any]]
    row_count: int
    truncated: bool


class ToolResult(BaseModel):
    """What the api's execute-plan tool returns."""

    model_config = ConfigDict(extra="ignore")
    plan_hash: str
    semantic_model_version: int
    data_executed_at: str
    result_sets: list[ToolResultSet]
    truncated: bool = False
    cache_hit: bool = False
    sources: list[dict[str, Any]] = []
    freshness: list[dict[str, Any]] = []


Status = Literal[
    "answered",
    "answered_facts_only",
    "clarification_needed",
    "not_authorized",
    "out_of_scope",
    "failed",
]


class AnswerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str
    status: Status
    intent: str
    summary: str
    verified_facts: list[dict[str, Any]] = []
    derived_calculations: list[dict[str, Any]] = []
    possible_explanations: list[dict[str, Any]] = []
    recommendations: list[dict[str, Any]] = []
    unknowns: list[str] = []
    clarification_question: str | None = None
    analytical_context: dict[str, Any] | None = None
    interpretation: str | None = None
    tables: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    freshness: list[dict[str, Any]] = []
    execution: dict[str, Any]
