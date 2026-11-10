# CURRENT.md — Project status

> Living document. Update it after every meaningful change (see [CLAUDE.md](CLAUDE.md)). Only list something as Implemented if it exists in the repository and has been run or tested.

**Project status:** Architecture and documentation initialization. **Application development has not started.**

**Current milestone:** Pre-Milestone 1. The documentation foundation is complete and audited; [Milestone 1](ROADMAP.md#milestone-1--repository-foundation-and-infrastructure) has not started.

**Last updated:** 2026-11-11 (after the product owner confirmed the stack, Kysely and Node 24)

## Implemented

- **Application: nothing.** No application, infrastructure or test code exists. `apps/*`, `packages/*` and `infrastructure/*` contain only README placeholders.
- Documentation (including the AI development workflow), ADRs, interface contracts and configuration schemas (Markdown and JSON Schema, draft v0). These are designs, not working software.
- `.github/workflows/ci.yml` has run on GitHub (2 runs; the latest, commit c874fdc, passed). It only checks that the required documents exist, that relative Markdown links resolve, that the JSON files are valid JSON, and that `.env.example` holds placeholders. The link check was added on 2026-11-11 and has not run on GitHub yet.
- Verified locally on 2026-11-11: all JSON files parse and all relative Markdown links resolve (checked with the CI script).

## Designed (documented, not implemented)

- Multi-tenant architecture: tenant model, RBAC + ABAC, RLS-based isolation with two defined exceptions ([SECURITY.md](SECURITY.md), [docs/architecture/tenant-model.md](docs/architecture/tenant-model.md))
- Deployment models: shared SaaS (Model A) and customer-hosted (Model B) ([ADR-0001](docs/adr/ADR-0001-deployment-strategy.md))
- Connector strategy and access modes ([DATA_CONNECTIVITY.md](DATA_CONNECTIVITY.md), [ADR-0004](docs/adr/ADR-0004-connector-architecture.md))
- Data storage strategy: PostgreSQL analytical store plus a separate vector store ([ADR-0002](docs/adr/ADR-0002-data-storage-strategy.md))
- Synchronization engine ([docs/data/sync-engine.md](docs/data/sync-engine.md), [ADR-0005](docs/adr/ADR-0005-synchronization-architecture.md))
- AI architecture: deterministic pipeline, query plans, deterministic time resolution, grounding ([AI_ENGINEERING.md](AI_ENGINEERING.md), [ADR-0006](docs/adr/ADR-0006-ai-orchestration.md))
- Caching: provider prompt caching, exact caching, semantic caching ([docs/ai/caching.md](docs/ai/caching.md), [ADR-0007](docs/adr/ADR-0007-caching-strategy.md))
- Security model ([SECURITY.md](SECURITY.md), [docs/security/](docs/security/))

## Completed work

- 2026-11-10: initial documentation foundation.
- 2026-11-10: documentation consistency and architecture readiness audit. Fixes:
  - Defined the RLS exceptions for membership lookup and worker system tasks (P-15, TI-15).
  - Resolved the conflict between BullMQ's no-eviction requirement and cache use, and corrected the claim that Redis is fully rebuildable (P-14).
  - Assigned embedding ownership to ai-engine (P-16).
  - Moved date arithmetic out of the LLM (P-17, QueryPlan schema).
  - Fixed semantic-cache time normalization.
  - Reordered the roadmap: LLM provisional choice before M4, exact cache in M6, no vectors in M6, worker process in Compose.
  - Added missing security controls (transport and at-rest encryption, sessions, CSRF and CORS, MFA, rotation, rate limits, upload handling).
  - Defined mapping "statistics" so no PII values reach the LLM.
  - Added OPEN decisions D-OPEN-15 to D-OPEN-18.
- 2026-11-10: added [AI_WORKFLOW.md](AI_WORKFLOW.md) (the AI-assisted development workflow) and referenced it from CLAUDE.md. This is process documentation, not application code.

- 2026-11-11: the product owner accepted the stack and tooling (D-11, D-12, formerly P-09 and P-10), chose Kysely for database access (D-13, [ADR-0009](docs/adr/ADR-0009-database-access-library.md)) and Node.js 24 LTS. Updated DECISIONS.md, ADR-0008, DEVELOPMENT.md and ROADMAP.md. CI now requires AI_WORKFLOW.md and checks relative Markdown links. No application code was written.

## In progress

- Nothing.

## Pending (next milestones)

- Milestone 1: Dockerized repository foundation (git, pnpm workspace, NestJS and FastAPI skeletons, Docker Compose with PostgreSQL, Redis and MinIO, CI running lint and tests).
- Milestone 2: Tenant management, authentication integration, RLS and the tenant isolation test harness.
- Milestones 3–10: see [ROADMAP.md](ROADMAP.md).

## Known issues and risks

- **Local toolchain (macOS arm64, checked 2026-11-11):** Docker 29 and Compose v2 are present. pnpm and uv are not installed (`corepack enable` provides pnpm). Python is 3.14; pin 3.12 through uv. Node is 24, which now matches the decision.
- [BusinessPilot_New_System_Setup_and_Implementation_Guide.md](BusinessPilot_New_System_Setup_and_Implementation_Guide.md) conflicts with the repo docs: it says to avoid host runtimes (DEVELOPMENT.md needs them), puts authentication in M1 (ROADMAP puts it in M2) and mentions a "SQL-validation flow" (the design uses query plans, P-03). Treat ROADMAP.md as authoritative. Decide whether to move the guide to `docs/` or delete it.
- OPEN decisions that block specific milestones:
  - In M2: identity provider (D-OPEN-03) and service authentication / RequestContext signing (D-OPEN-15).
  - Before M4: provisional LLM provider (D-OPEN-01).
  - Before M7: embedding model and vector store (D-OPEN-02, D-OPEN-06).
  - Before M10: cloud and region, retention defaults, backup targets, license and pricing (D-OPEN-04, -12, -17, -10, -11).
- The Redis distribution's license must be checked before any customer-hosted distribution ([ADR-0008](docs/adr/ADR-0008-technology-selection.md)).
- `schemas/` (configuration) and `contracts/` (component interfaces) both hold JSON Schemas. Their roles are defined in [contracts/README.md](contracts/README.md). Generated validators must stay in sync with them.
- The three `packages/*` folders are placeholders. Create each package only when the first code needs it, to avoid empty build machinery.
- No schema exists yet for the `ai_configuration` document (planned for M6).
- The wholesale-distribution template entities and all numeric defaults (TTLs, thresholds, retention periods, limits) are unvalidated hypotheses.

## Important technical decisions

See [DECISIONS.md](DECISIONS.md): 13 Accepted, 15 Proposed, 17 OPEN. In summary: shared SaaS first, with portable architecture; hybrid relational and vector storage; layered tenant isolation (application authorization plus PostgreSQL RLS); the LLM never decides permissions; a deterministic pipeline producing validated query plans; a sync engine independent of AI; a modular monolith plus a separate AI engine; no Kafka or Kubernetes.

## Next three actionable tasks

1. **Repository foundation (M1a):** pnpm workspace on Node 24; Kysely in the api; `apps/api` NestJS skeleton with HTTP and worker entrypoints and a health endpoint; `apps/ai-engine` FastAPI skeleton (uv) with a health endpoint; `apps/web` Next.js skeleton; `infrastructure/docker/compose.yaml` with PostgreSQL, Redis Stack (`noeviction`, AOF) and MinIO.
2. **CI baseline:** extend `.github/workflows/ci.yml` to lint, type-check and test all apps. Add secret scanning and dependency audit.
3. **Tenant isolation foundation:** migrations for `tenant`, `app_user`, `tenant_membership`; the roles `bp_owner`, `bp_app` and `bp_system`; RLS policies including the membership-lookup exception; the `withTenantTx` helper using `SET LOCAL`; isolation tests TI-01 to TI-05 and TI-15.
