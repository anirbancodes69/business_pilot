# DECISIONS.md — Decision register

This file lists every architectural decision with its status. The reasoning for each is in the ADRs in [docs/adr/](docs/adr/).

**Status meanings**

- **Accepted:** required by the founding product brief (2026-11-10) or confirmed by the product owner. Changing it needs a new or superseding ADR.
- **Proposed:** the recommended option, still awaiting product-owner confirmation. Build on it, but expect possible change.
- **OPEN:** not decided. Options and a recommendation are recorded where possible. Do not build on it without deciding first.

To change a status, update the ADR and this table in the same commit. Only the product owner moves a decision to Accepted.

## Accepted

| ID | Decision | ADR |
|---|---|---|
| D-01 | Launch as shared SaaS (Model A). Customer-hosted (Model B) is a future edition. Application logic and config contracts stay portable between them. | [0001](docs/adr/ADR-0001-deployment-strategy.md) |
| D-02 | Structured analytical storage and vector storage are separate capabilities. The vector store never replaces relational analytics. Financial and personal records are not embedded by default. | [0002](docs/adr/ADR-0002-data-storage-strategy.md) |
| D-03 | Tenant isolation is layered: application authorization plus database-level enforcement plus tenant-scoped vector, cache, files and audit. Shared infrastructure never implies shared authorization. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| D-04 | The LLM never decides permissions. Authorization is enforced by trusted application and data-access layers. | [0003](docs/adr/ADR-0003-tenant-isolation.md), [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| D-05 | Authorization model is RBAC + ABAC. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| D-06 | The sync engine is independent of AI orchestration. Structured-to-vector propagation uses a reliable delivery pattern. | [0005](docs/adr/ADR-0005-synchronization-architecture.md) |
| D-07 | AI orchestration is deterministic, with no uncontrolled agent loops. Financial figures are grounded in structured query results. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| D-08 | Cache identity includes tenant, authorization scope, normalized plan, semantic model version, data version and cache policy version. Financial results are never reused on embedding similarity alone. | [0007](docs/adr/ADR-0007-caching-strategy.md) |
| D-09 | The backend is a modular monolith, with a separately deployable AI service and workers. No Kafka or Kubernetes without a documented reason. | [0008](docs/adr/ADR-0008-technology-selection.md) |
| D-10 | AI-assisted schema mappings and semantic model changes need human approval before production activation. | [0004](docs/adr/ADR-0004-connector-architecture.md) |
| D-11 | Stack (formerly P-09): Next.js, NestJS, FastAPI, PostgreSQL, Redis Stack, BullMQ, S3-compatible storage, Docker Compose, OpenTelemetry and Grafana, OpenAPI, JSON Schema and Pydantic. Node.js 24 LTS and Python 3.12+. Redis's *vector* role remains subject to D-OPEN-06. Confirmed by the product owner 2026-11-11. | [0008](docs/adr/ADR-0008-technology-selection.md) |
| D-12 | Tooling (formerly P-10): pnpm workspaces for TypeScript (no Turborepo until build times need it). uv for Python. Confirmed 2026-11-11. | [0008](docs/adr/ADR-0008-technology-selection.md) |
| D-13 | Database access (formerly D-OPEN-16): Kysely query builder and its migrator for `apps/api`. SQL stays explicit, no ORM. RLS policies and roles are written as raw SQL migrations. Confirmed 2026-11-11. | [0009](docs/adr/ADR-0009-database-access-library.md) |
| D-14 | Semantic model v1 (formerly D-OPEN-22): option A. Additivity, polarity, valid dimensions, drivers, derived metrics (code-registry formulas), business definitions, hierarchies, diagnostic flags, member synonyms and business rules are added together before the wholesale template is published. Schema 0.2.0. Confirmed 2026-11-13. | [0013](docs/adr/ADR-0013-semantic-model-v1.md) |
| D-15 | Interim: the LLM provider and object storage sit behind ports and use dummy adapters only (no model call, in-memory non-durable storage). The real provider and product are still OPEN (D-OPEN-01, D-OPEN-24). No pilot tenant while either is a dummy. Confirmed 2026-11-14. | [0015](docs/adr/ADR-0015-dummy-llm-and-object-storage-adapters.md) |
| D-16 | Access policy grants (formerly P-21): an access policy may grant only non-data permissions from the permission catalog, and never `tenant:manage`, `user:manage`, `data_source:manage`, `mapping:approve`, `semantic_model:manage` or `semantic_model:publish`: those come from a role assignment only, so a policy cannot bypass human approval (D-10). Policy rules must name columns known for the entity. Confirmed 2026-11-14. | [0014](docs/adr/ADR-0014-m2-authentication-service-trust-and-rls-details.md) |

## Proposed

| ID | Decision | ADR |
|---|---|---|
| P-01 | Pooled tenancy: one database, shared schema, `tenant_id` on every tenant table, with RLS forced. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| P-02 | The AI engine has no direct access to tenant data stores. It uses the API's internal tool endpoints, authenticated by a signed RequestContext. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| P-03 | The LLM emits a structured `QueryPlan` that the API compiles to parameterized SQL. Raw LLM-written SQL is disabled. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| P-04 | One connector interface with a capability descriptor. Connectors run inside the api/worker process. | [0004](docs/adr/ADR-0004-connector-architecture.md) |
| P-05 | MVP sync uses polling, timestamp cursors and fingerprints, plus periodic reconciliation. Source CDC comes after the MVP. | [0005](docs/adr/ADR-0005-synchronization-architecture.md) |
| P-06 | Transactional outbox in PostgreSQL, relayed to BullMQ, for indexing and cache invalidation events. | [0005](docs/adr/ADR-0005-synchronization-architecture.md) |
| P-07 | The semantic cache maps a question to a validated plan only. Result reuse always goes through the exact cache. | [0007](docs/adr/ADR-0007-caching-strategy.md) |
| P-08 | One Redis vector index per tenant (`idx:t:{tenant_id}:*`). Revisit if the tenant count makes this costly. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| P-11 | Canonical entities live in fixed per-template tables with a JSONB `ext` column for tenant-specific attributes. | [0002](docs/adr/ADR-0002-data-storage-strategy.md) |
| P-12 | Connector credentials use envelope encryption behind a `KeyManagement` port. Only references are stored in configuration. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| P-13 | Semantic models are immutable once published. Each change creates a new version. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| P-14 | Redis runs with `maxmemory-policy noeviction` (a BullMQ requirement) and AOF persistence. Caches are bounded by TTL and a memory budget, not by eviction. A separate cache instance is split out if cache memory pressure threatens queues. | [0008](docs/adr/ADR-0008-technology-selection.md) |
| P-15 | Two narrowly scoped exceptions to per-tenant RLS: (a) a membership-lookup policy keyed on `app.user_id`, for tenant selection at login; (b) a `bp_system` role for worker system tasks (outbox relay, scheduler, retention sweeps), granted only on named control-plane tables and with no access to `analytics`. | [0003](docs/adr/ADR-0003-tenant-isolation.md) |
| P-16 | ai-engine computes all embeddings (query time and indexing). api and worker store and search vectors and never call embedding providers. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| P-17 | The planner emits time ranges either as relative tokens (for example `last_month`, `fiscal_ytd`) or as absolute dates. A deterministic resolver converts them to absolute dates before validation. The LLM does no date arithmetic. | [0006](docs/adr/ADR-0006-ai-orchestration.md) |
| P-18 | Authentication through an external OIDC provider. The api verifies tokens and reads identity only. Tenant selection is a request checked against membership. No provider configured means every authenticated route fails closed (formerly D-OPEN-03, approach only). | [0014](docs/adr/ADR-0014-m2-authentication-service-trust-and-rls-details.md) |
| P-19 | Service trust (MVP): a shared service token for internal endpoints, plus an HMAC-SHA256 signed, 2-minute RequestContext bound to the request ID, with key rotation overlap (formerly D-OPEN-15). | [0014](docs/adr/ADR-0014-m2-authentication-service-trust-and-rls-details.md) |
| P-20 | RLS details: `set_config(..., true)` as the parameterized form of `SET LOCAL`; `app_user` and `permission` as the only non-RLS global tables; non-superuser `bp_owner`; `bp_system` without login until Milestone 5. | [0014](docs/adr/ADR-0014-m2-authentication-service-trust-and-rls-details.md) |

## OPEN

| ID | Question | Current recommendation |
|---|---|---|
| D-OPEN-01 | LLM provider(s) and models | Keep behind an `LlmProvider` port. Make a *provisional* choice before Milestone 4, because mapping suggestions need an LLM. Confirm it from evaluation results (Milestone 6) and data-processing terms. **Interim (2026-11-14): dummy provider, see D-15.** |
| D-OPEN-02 | Embedding model and dimension | Decide alongside D-OPEN-01. Store the model ID with every vector. |
| D-OPEN-03b | Which identity provider vendor (the approach is Proposed as P-18) | Pick a managed OIDC vendor that supports MFA, with India-region data handling. Any compliant provider works with the api as built. Decide before the first pilot tenant. |
| D-OPEN-04 | Cloud provider and region | An India region for data residency. Decide before Milestone 10. |
| D-OPEN-05 | Policy engine | In-code typed policies for the MVP. Re-evaluate Cedar or OPA when policies become tenant-authored. |
| D-OPEN-06 | Final vector store | Redis Stack (proposed) vs pgvector. Check licensing for Model B distribution. |
| D-OPEN-07 | Scope of live/federated mode | After the MVP, PostgreSQL and MySQL read replicas first. Spreadsheets stay sync-only. |
| D-OPEN-08 | Private connector for firewalled sources | An outbound-only agent that the customer installs. Design after the MVP (deferred from Milestone 4). |
| D-OPEN-09 | Customer-hosted packaging and updates | Docker Compose bundle first. Helm only with an ADR. |
| D-OPEN-10 | Software license and distribution | Proprietary, to be decided by the owner. |
| D-OPEN-11 | Pricing and packaging | Decide using measured cost per answer. |
| D-OPEN-12 | Default retention for conversations, query logs and audit | Configurable per tenant. Defaults to be set with legal review. |
| D-OPEN-13 | Custom entities beyond templates | Templates plus JSONB for the MVP. Revisit dynamic tables after pilots. |
| D-OPEN-14 | What result data the LLM may see (aggregates only vs bounded rows) and provider data-retention terms | Aggregates and bounded top-N rows. PII columns masked unless policy allows. |
| D-OPEN-17 | Backup and recovery targets (RPO/RTO), and backup retention window | Set before Milestone 10. The retention window must be disclosed to customers (see data-handling). |
| D-OPEN-18 | Usage metering and quota model (questions, tokens, sync volume per tenant) | Meter from Milestone 6 (in `ai_execution`). Quota limits follow D-OPEN-11. |
| D-OPEN-19 | Bounded adaptive investigation: may the orchestrator choose further steps from a closed catalog within a hard budget, and who chooses ([ADR-0010](docs/adr/ADR-0010-bounded-adaptive-investigation.md)) | Option A: deterministic rules choose drill steps; LLM selection only if evaluation shows gains. Refines D-07, does not replace it. Decide before Milestone 6. |
| D-OPEN-20 | Structured analytical conversation state replacing the free-text `conversation_summary` ([ADR-0011](docs/adr/ADR-0011-analytical-conversation-state.md)) | Option A: typed `AnalyticalContext`, re-authorized by the api every turn. Contract change. Decide before Milestone 6. |
| D-OPEN-21 | Numerical provenance and evidence ledger; how narrative references numbers ([ADR-0012](docs/adr/ADR-0012-numerical-provenance-and-evidence.md)) | Option A: evidence placeholders rendered by code, grounding check kept. Contract change. Decide before Milestone 6. |
| D-OPEN-23 | How recommendations are generated: template playbooks, LLM wording over findings, or hybrid | Hybrid: deterministic playbook triggers per template, LLM wording, mandatory evidence citation. Needs an ADR before Milestone 6. |
| D-OPEN-24 | Object storage product (S3-compatible) for uploads and files. The MinIO images used locally are no longer published | Choose a supported S3-compatible store (a managed one in Model A). Interim: dummy adapter, see D-15. Decide before Milestone 5 (the worker needs shared storage) and before any pilot. |
