# DEVELOPMENT.md — Development guide

> **Status:** the Milestone 1 skeleton exists (health endpoints only). Commands marked *(planned)* do not work yet.

## Prerequisites

- Docker with Docker Compose v2
- Node.js 24 LTS (`.nvmrc`) and pnpm (pinned by `packageManager` in the root `package.json`; `corepack enable`). Corepack cannot run pnpm 12, so the pin stays on 10.x.
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) (uv installs the pinned 3.12 itself)
- Git

## First-time setup

```bash
./scripts/setup-local-env.sh               # creates .env with random local secrets; never overwrites an existing .env
pnpm install
uv sync --directory apps/ai-engine
pnpm stack:up                              # builds and starts everything; waits until all services are healthy
pnpm stack:up:observability                # same, plus a local Grafana stack on http://127.0.0.1:3100 (traces)
pnpm stack:down
pnpm --filter @businesspilot/api db:migrate   # no migrations exist yet; runs as bp_owner against the Compose database
```

Health: web `:3000/api/health`, api `:3001/health/live` and `/health/ready` (checks Postgres and ai-engine), worker `:3002/health/*` (container only), ai-engine `:8000/health`. Host ports bind to 127.0.0.1.

Running apps outside Docker *(planned convenience; not verified)*: `pnpm --filter @businesspilot/api dev` compiles in watch mode, then `node apps/api/dist/main.js`; `uv run --directory apps/ai-engine uvicorn ai_engine.main:app`; `pnpm --filter @businesspilot/web dev`.

## Repository conventions

### Structure

- `apps/api` is a NestJS **modular monolith** with two entrypoints: `main.ts` (HTTP) and `worker.ts` (BullMQ consumers). Modules talk to each other through their exported services, never through each other's tables.
- Proposed modules: `identity`, `tenancy`, `authorization`, `configuration`, `semantic-model`, `connectors`, `sync`, `data-access` (plan compiler, execution, exact cache, retrieval), `conversations`, `audit`, `platform` (crypto, storage, outbox, telemetry).
- `apps/ai-engine` is organized as `pipeline/`, `stages/`, `prompts/` (versioned), `providers/` (LLM and embedding ports), `tools/` (API tool client), `evaluation/`.
- Configuration document schemas live in `schemas/`. Component interface contracts live in `contracts/`. See [contracts/README.md](contracts/README.md).

### TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess`. No `any` without a comment explaining why.
- ESLint (flat config) and Prettier. Zod validates every runtime boundary: HTTP input, job payloads, configuration documents, AI engine responses.
- Test runner: Vitest (all TypeScript packages, D-11/D-12).
- Database access uses Kysely (D-13, ADR-0009) and goes only through the tenant-aware transaction helper (`withTenantTx(tenantId, fn)`). A lint rule forbids importing the raw pool or raw Redis client outside `platform`.

### Python

- Python 3.12+, uv, ruff (lint and format), mypy `--strict`, pytest, Pydantic v2 models for every contract.
- No database or Redis clients in `ai-engine`. Data access goes only through `tools/` (P-02).

### General

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Atomic commits.
- IDs are UUIDs. Timestamps are `timestamptz` in UTC. Money is `numeric(18,4)` with an explicit currency, never floating point.
- Migrations are forward-only and reviewed. Every new tenant table needs RLS enabled and forced, a policy, and an isolation test in the same PR.
- New dependencies need a one-line justification in the PR description.

## Testing

| Suite | Command | Required when |
|---|---|---|
| All unit tests (TS and Python), one command | `pnpm test` | Always |
| TS integration *(planned)* (real PostgreSQL and Redis through Compose) | `pnpm test:integration` | Any change to data access, sync, cache, jobs |
| **Tenant isolation** *(planned, M2)* | `pnpm test:isolation` | Any change to data access, cache, retrieval, jobs, storage. Blocks release if failing |
| Python unit only | `uv run --directory apps/ai-engine pytest` | Always for ai-engine |
| AI evaluation *(planned)* | `uv run python -m evaluation.run --suite golden` | Prompt, model, planner or semantic layer changes |
| Lint and types (TS and Python) | `pnpm lint && pnpm typecheck` | Always |

Tests that touch tenant data use at least **two tenants** with overlapping natural keys, so leaks are detectable.

## Environment variables

See [.env.example](.env.example). Placeholders only. Secrets for shared environments come from the secret store, never from files in the repository.

## Documentation workflow

1. Read [CURRENT.md](CURRENT.md) before starting.
2. Update [CURRENT.md](CURRENT.md) after meaningful work.
3. Architecture changes go in an ADR ([docs/adr/TEMPLATE.md](docs/adr/TEMPLATE.md)) plus [DECISIONS.md](DECISIONS.md).
4. Contract changes (`contracts/`, `schemas/`) bump the schema's `version` and note compatibility.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push to `main` and every pull request: documentation and schema checks; `apps` (lint, type-check, `pnpm test`, build for all three apps); gitleaks secret scanning; dependency audit (`pnpm audit --prod` at high severity, `pip-audit`); and a Compose smoke test that must reach all-healthy. All jobs passed on GitHub on 2026-11-11 (see [CURRENT.md](CURRENT.md)). It also runs on pushes to `feature/**`.

## Observability

The api and ai-engine export OpenTelemetry traces (OTLP/HTTP; `OTEL_TRACES_EXPORTER=otlp|console|none`). Context propagates by W3C `traceparent`. `x-request-id` is accepted only if it matches a safe pattern, otherwise generated, and is set as the `request_id` span attribute and echoed in responses. It is for correlation only and never for authorization.
