# apps/api — NestJS modular monolith

**Status: Milestones 1 to 4 at API level** (see [CURRENT.md](../../CURRENT.md)). Milestone 3 added semantic model versions, access policies and the authorized view (`/v1/semantic-models`, `/v1/access-policies`, `/v1/semantic-view`). Milestone 4 added connectors, data sources, Excel upload and the mapping workflow (`/v1/connectors`, `/v1/data-sources/...`). No plan compiler, sync or internal tool endpoints exist yet. Earlier: both entrypoints, health endpoints, request_id, OpenTelemetry, Zod config; Milestone 2 security foundation (control-plane migrations with forced RLS, `withTenantTx`, OIDC token verification, membership-checked tenant selection, RBAC with the AuthorizationContext builder, audit events, envelope encryption, signed RequestContext); endpoints `/v1/me`, `/v1/tenant`, `/v1/memberships`, `/v1/audit-events`. Worker only exposes a health port until the first job exists.

One codebase, two process types:

- `main.ts`: the HTTP API (public REST, plus internal tool endpoints for ai-engine)
- `worker.ts`: BullMQ consumers (planned; health port only today) (sync, outbox relay, vector indexing, reconciliation, retention)

Proposed modules: identity, tenancy, authorization, configuration, semantic-model, connectors, sync, data-access (plan compiler, execution, exact cache, retrieval), conversations, audit, platform (crypto, storage, outbox, telemetry, tenant-aware DB and Redis wrappers).

Read before coding: [SECURITY.md](../../SECURITY.md), [DATA_CONNECTIVITY.md](../../DATA_CONNECTIVITY.md), [docs/ai/orchestration-pipeline.md](../../docs/ai/orchestration-pipeline.md#plan-compiler-in-the-api-not-in-ai-engine).
