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

When one ADR holds decisions with different statuses, its **Decision items** table gives the status of each item, using the IDs in DECISIONS.md.
