# ROADMAP.md — Milestones

Ordering principle: reach a **working vertical slice** fast. The slice is one pilot-like tenant that uploads an Excel file, approves a mapping, asks "Which customers have the highest outstanding payments?" and gets a correct, sourced, permission-aware answer. That slice is reached at the end of Milestone 6. Milestones 7–9 deepen it; Milestone 10 validates it with customers.

Where a later milestone's items are needed by the slice, a thin version is pulled forward, and each milestone says what it defers.

Status of every milestone: Milestone 1 **In progress** (implemented on branch `feature/repo-foundation`, pending review); all others **Not started** (see [CURRENT.md](CURRENT.md)).

---

## Milestone 1 — Repository foundation and infrastructure

**Epics**

- E1.1 Monorepo: git, pnpm workspace, uv project, shared lint and format configuration.
- E1.2 Skeletons: `apps/web` (Next.js), `apps/api` (NestJS with HTTP and worker entrypoints), `apps/ai-engine` (FastAPI). Each has a health endpoint.
- E1.3 `infrastructure/docker/compose.yaml`: PostgreSQL, Redis Stack (with `noeviction` and AOF, P-14), MinIO (S3-compatible), and the four processes: web, api, worker, ai-engine.
- E1.6 ~~Decide D-OPEN-16~~ Decided 2026-11-11: Kysely (D-13, ADR-0009). Set it up with the api skeleton.
- E1.4 CI: lint, type-check and unit tests for all apps. Secret scanning. Dependency audit.
- E1.5 OpenTelemetry wiring with a shared `request_id` across api and ai-engine. A local Grafana stack is optional in this milestone.

**Depends on:** none.
**Acceptance:** `docker compose up` brings up all services healthy. One command runs all tests in CI and locally. A trace spans api → ai-engine with a shared `request_id`. (Browser tracing is not required.)

## Milestone 2 — Tenant management and security

**Epics**

- E2.1 Control-plane schema: tenant, app_user, tenant_membership, role, permission, audit_event.
- E2.2 OIDC login integration (after deciding D-OPEN-03) and active-tenant selection.
- E2.3 RLS foundation: owner and app roles, `withTenantTx`, policies, lint rules against raw clients.
- E2.4 Authorization: RBAC, the `AuthorizationContext` builder, `authz_scope_hash`, default deny.
- E2.5 Tenant isolation test harness, tests TI-01 to TI-05. Later tests are added in the milestones listed in [tenant-isolation-tests.md](docs/security/tenant-isolation-tests.md).
- E2.6 Envelope encryption service behind `KeyManagement`.
- E2.7 Decide D-OPEN-15 (service authentication, RequestContext signing). Implement the `bp_system` role and the membership-lookup policy (P-15), with test TI-15.

**Depends on:** M1.
**Acceptance:** two tenants with overlapping data cannot see each other's records through any API. The isolation suite runs in CI and blocks merges. Audit events are recorded for membership and role changes.

## Milestone 3 — Configuration and semantic model

**Epics**

- E3.1 Configuration service that validates documents against [schemas/](schemas/), with versioning and an approval workflow.
- E3.2 The `wholesale_distribution v0` template: canonical tables in `analytics` with RLS, and a default semantic model (measures such as revenue, outstanding receivables, gross margin).
- E3.3 Semantic model publishing (immutable versions) and the authorized view builder.
- E3.4 ABAC row filters (branch assignment) and column masks.

**Depends on:** M2.
**Acceptance:** a tenant admin can publish a semantic model version. A sales manager's authorized view contains only permitted measures and carries the correct branch filter.

## Milestone 4 — Data connector framework

**Epics**

- E4.1 Connector interface, capability descriptor, connector registry ([contracts/connector/](contracts/connector/)).
- E4.2 Excel upload connector (object storage, sheet and table detection, key column selection).
- E4.3 PostgreSQL connector (read-only test, privilege check, schema discovery).
- E4.0 Make a provisional D-OPEN-01 choice (LLM provider behind the `LlmProvider` port). It is confirmed in E6.1.
- E4.4 AI-assisted mapping suggestion (a thin call into ai-engine, metadata only) and a human approval UI. Name-similarity heuristics are the fallback when the LLM is unavailable.
- **Deferred:** Google Sheets (end of M5 or M9), MySQL and MongoDB (after M6), private connector agent (D-OPEN-08).

**Depends on:** M3.
**Acceptance:** a user uploads an Excel file or connects PostgreSQL, sees the discovered schema, reviews suggested mappings, and approves them. Credentials are never returned or logged.

## Milestone 5 — Synchronization engine

**Epics**

- E5.1 Sync jobs on BullMQ: full ingestion, idempotent upserts with content hash, checkpoints in the same transaction as the data.
- E5.2 Incremental sync: timestamp cursor (PostgreSQL), fingerprint diff (Excel).
- E5.3 Delete propagation through key-set reconciliation. Schema drift detection with pause and re-approval.
- E5.4 Transactional outbox and relay. `data_version` bump per dataset.
- E5.5 Retry, backoff, dead-letter, and sync status and freshness API and UI.

**Depends on:** M4.
**Acceptance:** re-running the same sync makes no changes. Deleted source rows are marked deleted after reconciliation. A breaking schema change pauses the source and alerts the admin. Freshness is visible per dataset.

## Milestone 6 — AI orchestration and natural-language querying (vertical slice complete)

**Epics**

- E6.1 Confirm D-OPEN-01 (LLM provider) using a small evaluation spike.
- E6.2 ai-engine pipeline stages 1–11 ([AI_ENGINEERING.md](AI_ENGINEERING.md#2-pipeline)), including the deterministic time resolver (P-17). Context retrieval is lexical only (no vectors until M7), and there is no semantic cache yet.
- E6.3 API internal tools: `execute-plan` (plan validation, ABAC injection, SQL compiler, read-only execution, audit) with signed RequestContext.
- E6.4 Derived calculations and grounding check.
- E6.5 Chat UI showing answer sections, sources and freshness.
- E6.6 Golden question set v0 (30–50 questions) on a synthetic distributor dataset, run in CI.
- E6.7 Exact result cache, basic version (the full key, data-version invalidation, TTL), because the MVP scope in [PRODUCT.md](PRODUCT.md) includes it. Test TI-07 (exact cache part).
- E6.8 Usage metering in `ai_execution` (D-OPEN-18).

**Depends on:** M5 (managed-sync data).
**Acceptance:** the six example questions in [PRODUCT.md](PRODUCT.md) are answered correctly against the synthetic dataset. A sales manager cannot obtain data for unassigned branches by any phrasing in the adversarial test set. Every number in an answer passes the grounding check.

## Milestone 7 — RAG and vector retrieval

**Epics**

- E7.1 Decide D-OPEN-02 and D-OPEN-06 (embedding model and vector store).
- E7.2 Per-tenant vector index. An indexing worker fed by the outbox, which gets embeddings from ai-engine's `/internal/v1/embeddings` (P-16), plus a re-index and reconciliation job.
- E7.3 Embedding glossary, metric definitions and schema descriptions to improve planning.
- E7.4 Approved document upload (policies) and the `knowledge` intent with citations.

**Depends on:** M6 (M5 outbox).
**Acceptance:** planning accuracy on synonym-heavy golden questions improves measurably over M6. Document answers cite their sources. Vector search never returns another tenant's content (TI-06).

## Milestone 8 — Exact and semantic caching

**Epics**

- E8.1 Exact cache hardening (the basic version shipped in E6.7): memory budgets, per-tenant cache policy, live-mode TTL handling.
- E8.2 Prompt ordering for provider prompt caching, with measurement of cached tokens.
- E8.3 Semantic plan cache scoped by tenant and authorization scope.
- E8.4 Cache metrics and admin controls (cache policy per tenant).

**Depends on:** M6, M7.
**Acceptance:** repeated questions hit the exact cache with identical answers. A sync that changes data invalidates affected entries. Two users with different scopes never share a cached result (TI-07). Cost per answer is measured before and after.

## Milestone 9 — Onboarding experience

**Epics**

- E9.1 A guided onboarding flow: connect a source → approve mapping → first answer in one session.
- E9.2 Google Sheets connector.
- E9.3 Data quality checks shown during onboarding (missing keys, duplicate customers, currency issues).
- E9.4 User invitation, role and branch assignment UI.

**Depends on:** M4–M8.
**Acceptance:** a new user without technical help gets from sign-up to a correct first answer from their own spreadsheet.

## Milestone 10 — Evaluation, security testing and customer pilot

**Epics**

- E10.1 Expanded golden set, plus evaluation on anonymized pilot-shaped data with consent.
- E10.2 Security review: threat model refresh, isolation suite audit, penetration test where feasible.
- E10.3 Legal review: DPDP Act obligations, data processing terms, provider terms (D-OPEN-14), retention defaults (D-OPEN-12).
- E10.4 Production environment in an India region (D-OPEN-04), backups and restore test, monitoring and alerting.
- E10.5 Pilot with 2–5 distributors. Collect qualitative feedback, answer accuracy and cost per answer. Inform pricing (D-OPEN-11).

**Depends on:** M9.
**Acceptance:** pilot customers use the product weekly. No open critical or high security findings. Measured accuracy and cost support a go/no-go decision on commercial launch.

---

## Later (not scheduled)

Live/federated mode (D-OPEN-07), MySQL and MongoDB connectors, CDC, the private connector agent, customer-hosted edition (Model B), ERP and CRM connectors, alerts and scheduled digests, manufacturing and retail templates.
