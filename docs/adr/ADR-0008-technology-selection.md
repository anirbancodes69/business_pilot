# ADR-0008: Technology selection

- **Status:** Accepted (D-09 system shape; D-11 stack; D-12 tooling; D-13 database access, see ADR-0009). Proposed (P-14). OPEN (D-OPEN-01, -02, -06).
- **Date:** 2026-11-10. Updated 2026-11-11: product owner confirmed the stack, tooling and Node 24.

| Item | Status |
|---|---|
| D-09 Modular monolith + separate AI service + workers; no Kafka or Kubernetes without an ADR | Accepted |
| D-11 Technology stack (table below), formerly P-09 | Accepted (2026-11-11) |
| D-12 pnpm workspaces; uv for Python, formerly P-10 | Accepted (2026-11-11) |
| P-14 Redis `noeviction` + AOF; caches bounded by TTL and budget | Proposed |
| D-13 Database access library and migration tool, formerly D-OPEN-16 | Accepted (2026-11-11), see [ADR-0009](ADR-0009-database-access-library.md) |

## Context

A small team needs to ship a secure vertical slice quickly, keep the infrastructure portable (Model B), and use the Python ecosystem for AI work. Each extra runtime or datastore adds operational cost.

## Decision (accepted stack)

| Component | Choice | Rationale | Main trade-off |
|---|---|---|---|
| Frontend | Next.js + TypeScript | Mature, typed, SSR when needed | Framework churn. Use the App Router conservatively |
| Backend | NestJS + TypeScript on Node.js 24 LTS | Modules and dependency injection fit a modular monolith. Shares types with web | Decorator-heavy. Keep domain logic framework-light |
| AI engine | Python 3.12 + FastAPI + Pydantic v2 | Best AI and evaluation ecosystem. Pydantic matches JSON Schema contracts | A second language and runtime |
| Primary DB | PostgreSQL (16+) | RLS, JSONB, strong SQL, available everywhere | Analytical scale limits (see ADR-0002) |
| Queue | BullMQ on Redis | Reuses Redis. Retries, delays, rate limits, dead-letter | Node-only consumers. Python doesn't consume jobs (by design) |
| Cache / vector | Redis Stack | One component for queue, cache and vector | **Licensing:** Redis changed its license terms in 2024–2025. Verify the exact distribution's license before Model B redistribution. pgvector is the fallback (D-OPEN-06) |
| Files | S3-compatible (MinIO locally) | Portable API | None significant |
| Containers | Docker + Docker Compose | Local development and the first Model B bundle | Not an orchestrator. Revisit at scale |
| Observability | OpenTelemetry + Grafana stack | Vendor-neutral | Self-hosting effort |
| API contracts | OpenAPI (public and internal) | Generated clients in `packages/api-contracts` | Must be kept in sync with code (generate from code or validate in CI) |
| Config validation | JSON Schema (source of truth in `schemas/`), Pydantic and Zod at runtime | Language-neutral | Two runtime validators to keep consistent (generate where possible) |
| TS tooling | pnpm workspaces, ESLint, Prettier, Vitest, Kysely | Fast, minimal | Turborepo deferred |
| Python tooling | uv, ruff, mypy, pytest | Fast, modern | — |

Not adopted: Kafka, Kubernetes, a service mesh, LangChain-style agent frameworks (thin provider clients are preferred), a separate vector database product, ORMs that hide SQL in the data-access module. The database access library and migration tool are Kysely and its migrator (D-13, [ADR-0009](ADR-0009-database-access-library.md)). Application code runs in Docker, so Node 24 is pinned in the Dockerfiles and in `.nvmrc` for host-side tooling.

## Alternatives considered

- **Single language (all TypeScript).** Fewer runtimes, but a weaker AI and evaluation ecosystem.
- **All Python (FastAPI backend).** Viable. NestJS was preferred in the brief for its structure and the type sharing with the frontend.
- **Microservices.** Not justified at this team size or load.

## Advantages

- Minimal component count: PostgreSQL, Redis, object storage and three app images.
- Everything runs locally in Compose and is portable to Model B.

## Disadvantages

- Two languages to maintain. Contract drift risk between Zod and Pydantic models.
- Redis concentrates three roles (queue, cache, vector). Its failure affects all three. The roles also have conflicting needs: BullMQ requires `maxmemory-policy noeviction` and durable persistence, while caches normally rely on eviction. Resolution (P-14): `noeviction` plus AOF persistence, caches bounded by TTL and a memory budget, and a separate cache instance once cache memory approaches the budget.

## Security implications

- Fewer components mean less attack surface. The Redis instance must require authentication, use TLS outside local development, and never be exposed publicly.
- A dependency policy (justification, lockfiles, scanning) applies to both ecosystems.

## Consequences

- Milestone 1 sets up both toolchains and CI for both.
- Contracts must be generated or validated against `schemas/` and `contracts/` to avoid drift.

## Revisit conditions

- Redis licensing blocks Model B. Then use pgvector and a separate queue backend.
- Sustained load or team growth justifies splitting a module out. That needs an ADR with metrics.
- BullMQ limits on throughput or visibility are reached. Then evaluate alternatives.
