# apps/ai-engine — Python + FastAPI AI orchestration

**Status: not started** (see [CURRENT.md](../../CURRENT.md)). Scaffolded in Milestone 1.

Runs the deterministic answer pipeline ([AI_ENGINEERING.md](../../AI_ENGINEERING.md)). It owns LLM and embedding provider access, versioned prompts and the evaluation suite.

Hard rules: no database or Redis clients, and no tenant data-store credentials. All data access goes through api tool endpoints ([contracts/ai/](../../contracts/ai/)). Not exposed publicly.

Planned layout: `src/ai_engine/{pipeline,stages,prompts,providers,tools,models}`, `evaluation/`, `tests/`. Tooling: uv, ruff, mypy strict, pytest, Pydantic v2.
