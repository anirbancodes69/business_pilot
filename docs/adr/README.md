# Architecture Decision Records

Each ADR records one significant decision. The status register is [DECISIONS.md](../../DECISIONS.md). New ADRs copy [TEMPLATE.md](TEMPLATE.md) and take the next number. ADRs are never deleted. They are superseded by later ones.

| ADR | Title | Status |
|---|---|---|
| [0001](ADR-0001-deployment-strategy.md) | Deployment strategy | Accepted (packaging details OPEN) |
| [0002](ADR-0002-data-storage-strategy.md) | Data storage strategy | Accepted (separation); Proposed (table layout) |
| [0003](ADR-0003-tenant-isolation.md) | Tenant isolation | Accepted (layered model); Proposed (pooled RLS, per-tenant vector index) |
| [0004](ADR-0004-connector-architecture.md) | Connector architecture | Proposed (human approval Accepted) |
| [0005](ADR-0005-synchronization-architecture.md) | Synchronization architecture | Accepted (independence); Proposed (mechanisms) |
| [0006](ADR-0006-ai-orchestration.md) | AI orchestration | Accepted (deterministic, grounded); Proposed (plan IR, tool boundary) |
| [0007](ADR-0007-caching-strategy.md) | Caching strategy | Accepted (cache identity); Proposed (mechanisms) |
| [0008](ADR-0008-technology-selection.md) | Technology selection | Accepted (modular monolith, stack, tooling); Proposed (Redis settings) |
| [0009](ADR-0009-database-access-library.md) | Database access library | Accepted (Kysely) |
| [0010](ADR-0010-bounded-adaptive-investigation.md) | Bounded adaptive investigation | OPEN |
| [0011](ADR-0011-analytical-conversation-state.md) | Structured analytical conversation state | OPEN |
| [0012](ADR-0012-numerical-provenance-and-evidence.md) | Numerical provenance and evidence model | OPEN |
| [0013](ADR-0013-semantic-model-v1.md) | Semantic model v1 extensions | OPEN |
| [0014](ADR-0014-m2-authentication-service-trust-and-rls-details.md) | Authentication, service trust and RLS details (M2) | Proposed |
| [0015](ADR-0015-dummy-llm-and-object-storage-adapters.md) | Dummy LLM provider and object storage adapters (provisional) | Accepted (interim) |
| [0016](ADR-0016-local-volume-storage-and-keycloak-for-development.md) | Local volume object storage and Keycloak for local development | Accepted (hosted choices OPEN) |
| [0017](ADR-0017-outbox-relay-and-the-bp-system-role.md) | Outbox relay and the `bp_system` role | Accepted |

When one ADR holds decisions with different statuses, its **Decision items** table gives the status of each item, using the IDs in DECISIONS.md.
