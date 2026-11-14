# ARCHITECTURE.md — System architecture

This is the top-level view. Detailed designs are linked from each section. Decision statuses (Accepted, Proposed, OPEN) are tracked in [DECISIONS.md](DECISIONS.md). This document describes the target design; only part of it is built. [CURRENT.md](CURRENT.md) says what exists.

## 1. Principles

1. Configuration over customization. Tenant differences live in validated configuration ([schemas/](schemas/)), not in code branches.
2. Tenant isolation by design, enforced in several independent layers.
3. Security and authorization run before AI execution, and again before data execution.
4. A source-independent connector framework.
5. Deployment-independent application code. Infrastructure sits behind ports.
6. Structured queries for numbers; vector retrieval for meaning.
7. Deterministic orchestration. The LLM fills bounded, schema-validated steps.
8. Observable and measurable AI execution: traces, cost, accuracy.
9. Incremental sync with checkpoints, retries and reconciliation.
10. Human approval for mappings and semantic model changes.
11. Data minimization.
12. No unnecessary services: a modular monolith, one AI service, workers.
13. Commercial viability: a working vertical slice comes before broad infrastructure.

## 2. Component view

```
                 ┌──────────────────────────────┐
  Browser ──────▶│ apps/web  (Next.js)          │
                 └──────────────┬───────────────┘
                                │ HTTPS, public REST API (OpenAPI)
                 ┌──────────────▼───────────────────────────────────────────┐
                 │ apps/api — NestJS modular monolith                        │
                 │  Process type: api (HTTP)      Process type: worker      │
                 │  ─────────────────────────     ───────────────────────── │
                 │  identity · tenancy            sync jobs                 │
                 │  authorization (RBAC+ABAC)     outbox relay              │
                 │  configuration · semantic      vector indexing           │
                 │  connectors · data-access      reconciliation scheduler  │
                 │  conversations · audit         retention / deletion      │
                 └───┬──────────────▲───────────────┬───────────┬───────────┘
   internal REST     │              │ internal tool │           │
   (query request)   │              │ calls         │           │
                 ┌───▼──────────────┴───┐   ┌───────▼──────┐ ┌──▼───────────┐
                 │ apps/ai-engine       │   │ PostgreSQL   │ │ Redis Stack  │
                 │ Python + FastAPI     │   │ control plane│ │ BullMQ queues│
                 │ deterministic        │   │ + analytical │ │ cache        │
                 │ pipeline, prompts,   │   │ store (RLS)  │ │ vector index │
                 │ LLM/embedding calls  │   └──────────────┘ └──────────────┘
                 └──────────┬───────────┘
                            │ HTTPS             S3-compatible object storage
                     LLM / embedding provider   (uploaded files, exports)

  Customer sources (Excel, Google Sheets, PostgreSQL, MySQL, MongoDB) are reached only by
  the api/worker connectors module, never by ai-engine.
```

### Deployable units

| Unit | Code | Responsibility |
|---|---|---|
| `web` | `apps/web` | UI: chat, onboarding, mapping approval, admin |
| `api` | `apps/api` (HTTP entrypoint) | Public API, authentication, authorization, configuration, data access, internal tool endpoints for ai-engine |
| `worker` | `apps/api` (worker entrypoint) | BullMQ consumers: discovery, sync, outbox relay, indexing (vectors come from ai-engine), reconciliation, retention. Cross-tenant scheduling runs as `bp_system` (P-15) |
| `ai-engine` | `apps/ai-engine` | The question-answering pipeline. The only component that calls LLM and embedding providers (P-16). Owns prompts |
| `postgres` | `infrastructure/postgres` | Control plane plus tenant analytical store |
| `redis` | `infrastructure/redis` | Queues, exact cache, semantic cache, vector index |

`api` and `worker` share one codebase and module set. This is a modular monolith with two process types, not two services.

### Infrastructure ports (deployment independence)

Application code depends on these interfaces. Adapters are chosen per deployment.

| Port | SaaS adapter (proposed) | Customer-hosted adapter |
|---|---|---|
| `ObjectStorage` | S3-compatible (cloud TBD) | MinIO or the customer's S3/Blob |
| `KeyManagement` | Cloud KMS | Customer KMS / Vault / local key file |
| `SecretStore` | Cloud secret manager | Vault / environment |
| `LlmProvider`, `EmbeddingProvider` | Provider API (D-OPEN-01/02) | Customer-approved endpoint |
| `VectorStore` | Redis Stack | Redis Stack or pgvector |
| `Queue` | BullMQ on Redis | Same |
| `IdentityProvider` | OIDC (D-OPEN-03) | Customer OIDC/SAML IdP |

## 3. Request lifecycle: answering a question

```
web ─▶ api: POST /v1/conversations/{id}/questions
 1. api   Authenticate. Resolve the tenant membership. Build the AuthorizationContext
          (roles, attributes, row filters, column grants) and compute authz_scope_hash.
          Check quotas.
 2. api   Load the active semantic model version. Build the user's *authorized view*
          of it (only entities, measures and dimensions the user may see).
 3. api ─▶ ai-engine: POST /internal/v1/answer
          {question, conversation summary, authorized view, signed RequestContext}
 4. ai    Input guard ─▶ intent classification ─▶ semantic cache lookup (tool) ─▶
          QueryPlan generation (schema-constrained) ─▶ plan self-validation
 5. ai ─▶ api: POST /internal/v1/tools/execute-plan {plan, RequestContext}
 6. api   Verify the RequestContext signature and expiry. Re-validate the plan against
          the semantic model and policy. Inject ABAC filters. Exact cache lookup.
          Compile to parameterized SQL. Execute in a read-only transaction with
          SET LOCAL app.tenant_id, a statement timeout and a row limit. Audit.
          Return rows, source references, freshness.
 7. ai    Deterministic derived calculations ─▶ explanation generation ─▶ grounding
          check (every number must trace to a result or derivation) ─▶ AnswerResponse
 8. api   Persist the conversation turn and AI execution record. Return to web.
```

Bounded diagnostic questions ("why did revenue fall?") repeat steps 5–6 for a fixed, plan-declared set of breakdowns (for example by branch, category and customer), capped at `max_tool_calls`. There are no open-ended loops. A proposed refinement lets the AI Analyst Orchestrator drill into a discovered contributor, choosing from a closed step catalog within the same budget, with every step re-authorized in step 6. It is OPEN ([ADR-0010](docs/adr/ADR-0010-bounded-adaptive-investigation.md)). Contracts: [contracts/ai/](contracts/ai/). Details: [docs/architecture/request-lifecycle.md](docs/architecture/request-lifecycle.md).

## 4. Data architecture (summary)

- **Control plane** (PostgreSQL, schema `core`): tenants, users, memberships, roles, policies, data sources, credential references, semantic models, mappings, conversations, audit, sync jobs.
- **Analytical store** (PostgreSQL, schema `analytics`): canonical entity tables per industry template. Every row has `tenant_id`, and RLS is forced.
- **Vector store** (Redis Stack): embeddings of *approved* glossary terms, metric definitions, schema descriptions, documents and policies. No financial or personal records by default.
- **Object storage**: uploaded Excel files and exports, under tenant-prefixed keys.

Why structured and vector storage are separate: [ADR-0002](docs/adr/ADR-0002-data-storage-strategy.md). Connectors, access modes and sync: [DATA_CONNECTIVITY.md](DATA_CONNECTIVITY.md).

## 5. Tenancy and security (summary)

Isolation layers (with exactly two defined RLS exceptions, P-15): (1) authentication and membership; (2) API authorization with RBAC and ABAC; (3) PostgreSQL RLS; (4) tenant-prefixed Redis keys and per-tenant vector indexes; (5) tenant context carried in every job payload and checked by workers; (6) cache keys that include the authorization scope; (7) mandatory isolation tests in CI. Details: [SECURITY.md](SECURITY.md), [docs/architecture/tenant-model.md](docs/architecture/tenant-model.md).

## 6. AI architecture (summary)

An **AI Analyst Orchestrator**: a deterministic state machine that runs intent → plan → validate → execute through the API → calculate → explain → ground-check, with a bounded investigation phase for diagnostic questions. It uses a versioned semantic business model, and every number carries provenance. Design: [docs/ai/analyst-orchestrator.md](docs/ai/analyst-orchestrator.md). There are three caches (provider prompt cache, exact result cache, semantic plan cache). Details: [AI_ENGINEERING.md](AI_ENGINEERING.md).

## 7. Deployment models

| | Model A: Shared SaaS (initial) | Model B: Customer-hosted (future) |
|---|---|---|
| Who operates it | BusinessPilot | The customer, or BusinessPilot under contract |
| Tenants per installation | Many | Usually one (multi-tenancy stays enabled) |
| Infrastructure | BusinessPilot's cloud account | The customer's AWS, Azure, private cloud or on-premises |
| Packaging | Containers on managed infrastructure (D-OPEN-04) | Docker Compose first; Helm only with an ADR (D-OPEN-09) |
| Isolation | Logical (RLS, scoped keys) on shared infrastructure | Physical installation plus the same logical controls |

Three terms that must not be confused:

- **Private connector:** a way for BusinessPilot (usually SaaS) to reach a data source in the customer's network, for example an outbound-only agent or a tunnel. The application still runs in BusinessPilot's infrastructure. (D-OPEN-08)
- **Private Cloud / BYOC:** the whole BusinessPilot stack runs in the customer's own cloud account (AWS, Azure, GCP) in infrastructure the customer owns.
- **On-premises:** the whole stack runs on infrastructure the customer operates in its own facilities.

Details: [docs/architecture/deployment-models.md](docs/architecture/deployment-models.md), [ADR-0001](docs/adr/ADR-0001-deployment-strategy.md).

## 8. Observability

OpenTelemetry traces span api → ai-engine → api tools → database, correlated by `request_id`. Browser tracing is optional. Metrics and logs go to a Grafana stack. AI-specific metrics (tokens, cost, latency per stage, cache hits, validation failures, grounding failures) are in [AI_ENGINEERING.md](AI_ENGINEERING.md#observability). Logs must never contain credentials, raw result rows or tenant prompt content.

## 9. Explicitly avoided

Kafka, Kubernetes, a service mesh, microservices per domain, multi-agent frameworks with free-form delegation, and a separate data warehouse product. Each can be reconsidered only through an ADR with a measured reason.
