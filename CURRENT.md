# CURRENT.md — Project status

> Living document. Update it after every meaningful change (see [CLAUDE.md](CLAUDE.md)). Only list something as Implemented if it exists in the repository and has been run or tested.

**Project status:** Milestone 1 (repository foundation) is complete and merged to `main` (PR #1, CI green on `main`). Only skeletons exist: health endpoints, telemetry and infrastructure. **No product feature exists.** Product direction: AI Business Analyst (documented 2026-11-13).

**Current milestone:** [Milestone 2](ROADMAP.md#milestone-2--tenant-management-and-security), not started.

**Last updated:** 2026-11-13 (AI Business Analyst product direction documented)

## Implemented

- **Milestone 1 skeletons (merged to `main` 2026-11-11; verified locally and in CI):**
  - pnpm workspace (`apps/web`, `apps/api`) plus a uv project (`apps/ai-engine`); shared ESLint, Prettier, ruff, mypy strict.
  - `apps/api` (NestJS): HTTP entrypoint with `/health/live` and `/health/ready` (checks Postgres and ai-engine); worker entrypoint with a health port only (no BullMQ yet); Zod config; request_id middleware; OpenTelemetry; Kysely and `pg` set up in `src/platform/database` with a migrator runner and an empty migrations folder (no tables); ESLint rule restricting `pg`, `kysely` and Redis clients to `src/platform`.
  - `apps/ai-engine` (FastAPI): `/health`, request_id, OpenTelemetry continuing the api trace. No DB or Redis clients.
  - `apps/web` (Next.js): app shell and `/api/health`.
  - `infrastructure/docker/compose.yaml`: postgres 16, Redis Stack (`noeviction`, AOF, password), minio, web, api, worker, ai-engine, optional `observability` profile. Verified: `up --wait` brought all 8 services healthy, with Redis settings, the `bp_app` role (no superuser, no BYPASSRLS) and the migrator checked.
  - Trace verified: one Tempo trace spans `bp-api` (GET) → `ai-engine.health` → `bp-ai-engine` (GET /health), and `request_id` is the same on all three spans.
  - `pnpm lint`, `pnpm typecheck`, `pnpm test` (13 api, 1 web, 3 ai-engine tests) and `pnpm build` pass. `pnpm audit --prod` shows one moderate finding; `pip-audit` shows none.
- Documentation (including the AI development workflow), ADRs, interface contracts and configuration schemas (Markdown and JSON Schema, draft v0). These are designs, not working software.
- `.github/workflows/ci.yml`: all five jobs (docs, apps, secret scan including gitleaks, dependency audit, Compose smoke) passed on GitHub for branch `feature/repo-foundation` (run 42916869932) and again on `main` after the merge (run 42918295849, commit 1b0193a). CI runs on pushes to `main` and `feature/**`, and on pull requests.
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
- Product direction, AI Business Analyst (2026-11-13): vision, positioning, five core AI capabilities, MVP scope and phases ([PRODUCT.md](PRODUCT.md)); AI Analyst Orchestrator, conversation state and provenance ([docs/ai/analyst-orchestrator.md](docs/ai/analyst-orchestrator.md)); semantic business model ([docs/ai/semantic-business-model.md](docs/ai/semantic-business-model.md)); evaluation gates for investigation, grounding and isolation ([docs/ai/evaluation.md](docs/ai/evaluation.md)). Several parts depend on OPEN ADR-0010 to ADR-0013.

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

- Documentation of the AI Business Analyst direction on branch `docs/ai-analyst-direction` (not merged).

## Pending (next milestones)

- Milestone 1 follow-ups: Kysely table-type method (chosen with the first migration); `pnpm stack:up` was not run against the real `.env` (verified with an equivalent throwaway env file).
- Milestone 2: Tenant management, authentication integration, RLS and the tenant isolation test harness.
- Milestones 3–10: see [ROADMAP.md](ROADMAP.md).

## Known issues and risks

- **Product direction vs accepted decisions (2026-11-13):** the AI Business Analyst direction conflicts with, or extends, existing documents in these places. Each is recorded as an OPEN decision rather than resolved silently:
  - C1, multi-step investigation vs D-07 / ADR-0006 §4 (breakdowns declared up front, "never decides to keep exploring"). Proposed bounded adaptive investigation: [ADR-0010](docs/adr/ADR-0010-bounded-adaptive-investigation.md), D-OPEN-19. ADR-0006 §4 stays in force until it is decided.
  - C2, free-text `conversation_summary` in `answer-response` v0.1.0 vs structured analytical state: [ADR-0011](docs/adr/ADR-0011-analytical-conversation-state.md), D-OPEN-20. Contract not changed yet.
  - C3, value-matching grounding vs strict per-number provenance: [ADR-0012](docs/adr/ADR-0012-numerical-provenance-and-evidence.md), D-OPEN-21. Contract not changed yet.
  - C4, semantic model schema v0 lacks additivity, polarity, hierarchies, drivers, business definitions and rules: [ADR-0013](docs/adr/ADR-0013-semantic-model-v1.md), D-OPEN-22. Schema not changed yet.
  - C5, "recommendation" as predefined checks vs evidence-based recommendations as a core capability: D-OPEN-23 (no ADR yet).
  - C6, M7 was titled "RAG"; renamed to make clear retrieval supports semantic understanding, scope unchanged.
  - C7, the evaluation suite lacked investigation, follow-up and provenance metrics; added, with unvalidated targets.
- **M6 scope risk:** the MVP AI Analyst capabilities (E6.9) make Milestone 6 larger. It may need splitting after the E6.0 decisions.

- **MinIO images are gone (found 2026-11-11):** `minio/minio` on Docker Hub, `quay.io/minio/minio` and `dl.min.io` binaries are no longer available. Compose uses `bitnamilegacy/minio:2025.7.23-debian-12-r3`, a frozen and unmaintained mirror, for local development only. ADR-0008 and E1.3 name MinIO. The product owner should choose a supported S3-compatible store, or build MinIO from source, before Model B or production. Not decided here.
- **Local Postgres `bp_owner` is a superuser** (image bootstrap role). M2 must create a non-superuser owner and the full role model.
- The worker readiness checks Postgres only. Redis is not checked because no Redis client exists yet (the BullMQ setup adds it inside `platform`).
- `apps/web` has no Next.js ESLint plugin (kept to the shared typescript-eslint config to avoid extra dependencies).
- Corepack cannot run pnpm 12 (native binary). `packageManager` is pinned to pnpm 10.34.9. Revisit later.
- `pnpm audit` reports one moderate advisory in a transitive dependency. `zod` is on 4.x because 3.x had a high advisory; `postcss` is forced by a pnpm override because Next bundles a vulnerable range.

- **Local toolchain (macOS arm64, 2026-11-11):** Docker 29, Compose v2, Node 24, pnpm 10.34.9 (via corepack, shim in `~/.local/bin`) and uv 0.13.7 (Homebrew) are installed. Python 3.12 is provided by uv.
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

See [DECISIONS.md](DECISIONS.md): 13 Accepted, 15 Proposed, 22 OPEN. In summary: shared SaaS first, with portable architecture; hybrid relational and vector storage; layered tenant isolation (application authorization plus PostgreSQL RLS); the LLM never decides permissions; a deterministic pipeline producing validated query plans; a sync engine independent of AI; a modular monolith plus a separate AI engine; no Kafka or Kubernetes.

## Next three actionable tasks

1. **Tenant isolation foundation (M2):** migrations for `tenant`, `app_user`, `tenant_membership`; the roles `bp_owner` (non-superuser), `bp_app` and `bp_system`; RLS policies including the membership-lookup exception; the `withTenantTx` helper using `SET LOCAL`; isolation tests TI-01 to TI-05 and TI-15.
2. **Decide D-OPEN-03 (identity provider) and D-OPEN-15 (service authentication, RequestContext signing)**, needed for M2.
3. **Product-owner review of ADR-0010 to ADR-0013 and D-OPEN-23.** ADR-0013 (semantic model v1) is needed before M3. The others are needed before M6.
