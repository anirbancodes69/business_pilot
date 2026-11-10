# apps/ai-engine — Python + FastAPI AI orchestration

**Status: skeleton** (Milestone 1; see [CURRENT.md](../../CURRENT.md)). Implemented: `GET /health`, request_id handling and OpenTelemetry (continues the api trace). No pipeline yet.

Runs the deterministic answer pipeline ([AI_ENGINEERING.md](../../AI_ENGINEERING.md)). It owns LLM and embedding provider access, versioned prompts and the evaluation suite.

Hard rules: no database or Redis clients, and no tenant data-store credentials. All data access goes through api tool endpoints ([contracts/ai/](../../contracts/ai/)). Not exposed publicly.

Planned layout: `src/ai_engine/{pipeline,stages,prompts,providers,tools,models}`, `evaluation/`, `tests/`. Tooling: uv, ruff, mypy strict, pytest, Pydantic v2.
