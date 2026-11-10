# ADR-0002: Data storage strategy

- **Status:** Accepted (D-02, separating structured and vector storage). Proposed (P-11, canonical table layout). The engine choices are in [ADR-0008](ADR-0008-technology-selection.md).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-02 Structured and vector stores are separate. Records are not embedded by default | Accepted |
| P-11 Fixed per-template canonical tables with a JSONB `ext` column | Proposed |
| D-OPEN-06 Final vector store engine | OPEN |
| D-OPEN-13 Custom entities beyond templates | OPEN |

## Context

Answers combine two different needs:

- **Exact numbers**, such as totals, outstanding balances, margins and rankings. These need complete record sets, joins, filters and aggregation with deterministic results.
- **Understanding meaning**: matching "dues" to *outstanding receivables*, finding the relevant metric definition, or citing a credit policy. This needs semantic similarity.

A vector database does approximate nearest-neighbour search over the top-k items. It cannot reliably sum 40,000 invoices, enforce a join or guarantee completeness. Embedding every financial and personal record would also raise cost, privacy exposure and deletion complexity, with no gain in accuracy.

## Decision

1. **Structured analytical store** (PostgreSQL, `analytics` schema). This is the only source of numeric answers. It holds canonical entities with `tenant_id`, RLS, upserts, soft-delete markers and optional snapshot tables.
2. **Vector store** (Redis Stack proposed). It holds only approved semantic content: glossary terms, metric definitions, schema and column descriptions, policies and documents. Business records are not embedded by default. A tenant may opt in to embedding specific low-sensitivity text fields, such as product descriptions, through the data source configuration.
3. **Control-plane data** (PostgreSQL, `core` schema) stays separate from analytical data.
4. **Files** go in S3-compatible object storage under tenant prefixes.
5. Canonical entities use **fixed per-template tables** (`analytics.customer`, `analytics.invoice`, …) with typed core columns and a JSONB `ext` column for tenant-specific attributes (P-11).

## Alternatives considered

- **Vector-only ("RAG over everything").** Rejected: the numbers it produces are incorrect, and it creates privacy exposure.
- **A separate warehouse product (ClickHouse, DuckDB, BigQuery).** Strong for analytics at scale, but it is extra infrastructure that SME data volumes do not need yet. Revisit on measured performance.
- **pgvector in the same PostgreSQL.** Fewer components and transactional consistency with the outbox. It remains a strong alternative (D-OPEN-06).
- **Dynamic per-tenant tables generated from source schemas.** Maximum flexibility, but semantic modelling, RLS and migrations become hard. Deferred (D-OPEN-13).
- **EAV (entity-attribute-value) storage.** Poor query performance and complex SQL.

## Advantages

- Numeric answers are exact and auditable through SQL.
- A smaller privacy footprint in the vector store.
- Fixed tables make the plan compiler, indexes and RLS straightforward.

## Disadvantages

- Two stores must be kept consistent (handled by the outbox, [ADR-0005](ADR-0005-synchronization-architecture.md)).
- JSONB extension attributes are less efficient to query than typed columns.

## Security implications

- RLS covers every analytical table. Vector content carries a `tenant_id` and lives in per-tenant indexes.
- Not embedding records means vector-store leaks expose definitions, not transactions.
- Deleting data must cover both stores and object storage.

## Consequences

- A template change means a migration. Templates are versioned.
- The plan compiler targets canonical tables only.

## Revisit conditions

- Typical aggregate query p95 latency above 2 s on pilot-scale data after indexing. Then evaluate a columnar store.
- More than about 30% of tenant questions need attributes that only exist in `ext`. Then promote them to typed columns or revisit D-OPEN-13.
- Redis licensing or operations block Model B. Then decide D-OPEN-06 in favour of pgvector.
