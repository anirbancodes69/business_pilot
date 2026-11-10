# DEVELOPMENT.md — Development guide

> **Status:** no application code exists yet. Commands marked *(planned)* are introduced in Milestone 1 and do not work today. Once a command works, update this file and remove its marker.

## Prerequisites (planned)

- Docker with Docker Compose v2
- Node.js 22 LTS and pnpm (version pinned through `packageManager` in the root `package.json`)
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Git

## First-time setup (planned)

```bash
git init                                   # the repository is not under git yet
cp .env.example .env                       # fill in local values only, never commit .env
docker compose -f infrastructure/docker/compose.yaml up -d postgres redis   # (planned)
pnpm install                               # (planned)
pnpm --filter api db:migrate               # (planned)
uv sync --project apps/ai-engine           # (planned)
pnpm dev                                   # (planned) web + api + worker
uv run --project apps/ai-engine fastapi dev  # (planned)
```

## Repository conventions

### Structure

- `apps/api` is a NestJS **modular monolith** with two entrypoints: `main.ts` (HTTP) and `worker.ts` (BullMQ consumers). Modules talk to each other through their exported services, never through each other's tables.
- Proposed modules: `identity`, `tenancy`, `authorization`, `configuration`, `semantic-model`, `connectors`, `sync`, `data-access` (plan compiler, execution, exact cache, retrieval), `conversations`, `audit`, `platform` (crypto, storage, outbox, telemetry).
- `apps/ai-engine` is organized as `pipeline/`, `stages/`, `prompts/` (versioned), `providers/` (LLM and embedding ports), `tools/` (API tool client), `evaluation/`.
- Configuration document schemas live in `schemas/`. Component interface contracts live in `contracts/`. See [contracts/README.md](contracts/README.md).

### TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess`. No `any` without a comment explaining why.
- ESLint (flat config) and Prettier. Zod validates every runtime boundary: HTTP input, job payloads, configuration documents, AI engine responses.
- Test runner: Vitest (proposed for all TypeScript packages, under P-09/P-10).
- Database access goes only through the tenant-aware transaction helper (`withTenantTx(tenantId, fn)`). A lint rule forbids importing the raw pool or raw Redis client outside `platform`.

### Python

- Python 3.12+, uv, ruff (lint and format), mypy `--strict`, pytest, Pydantic v2 models for every contract.
- No database or Redis clients in `ai-engine`. Data access goes only through `tools/` (P-02).

### General

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Atomic commits.
- IDs are UUIDs. Timestamps are `timestamptz` in UTC. Money is `numeric(18,4)` with an explicit currency, never floating point.
- Migrations are forward-only and reviewed. Every new tenant table needs RLS enabled and forced, a policy, and an isolation test in the same PR.
- New dependencies need a one-line justification in the PR description.

## Testing

| Suite | Command (planned) | Required when |
|---|---|---|
| TS unit | `pnpm test` | Always |
| TS integration (real PostgreSQL and Redis through Compose) | `pnpm test:integration` | Any change to data access, sync, cache, jobs |
| **Tenant isolation** | `pnpm test:isolation` | Any change to data access, cache, retrieval, jobs, storage. Blocks release if failing |
| Python unit | `uv run pytest` | Always for ai-engine |
| AI evaluation | `uv run python -m evaluation.run --suite golden` | Prompt, model, planner or semantic layer changes |
| Lint and types | `pnpm lint && pnpm typecheck`, `uv run ruff check && uv run mypy` | Always |

Tests that touch tenant data use at least **two tenants** with overlapping natural keys, so leaks are detectable.

## Environment variables

See [.env.example](.env.example). Placeholders only. Secrets for shared environments come from the secret store, never from files in the repository.

## Documentation workflow

1. Read [CURRENT.md](CURRENT.md) before starting.
2. Update [CURRENT.md](CURRENT.md) after meaningful work.
3. Architecture changes go in an ADR ([docs/adr/TEMPLATE.md](docs/adr/TEMPLATE.md)) plus [DECISIONS.md](DECISIONS.md).
4. Contract changes (`contracts/`, `schemas/`) bump the schema's `version` and note compatibility.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) currently checks that all JSON Schema files are valid JSON and that the required root documents exist. Milestone 1 extends it with lint, type-check and tests for each app.
