# ADR-0005: Synchronization architecture

- **Status:** Accepted (D-06, independence from AI and reliable delivery). Proposed (P-05, P-06, the mechanisms).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-06 The sync engine is independent of AI orchestration, with reliable structured-to-vector delivery | Accepted |
| P-05 MVP uses polling, cursors and fingerprints plus reconciliation; CDC after the MVP | Proposed |
| P-06 Transactional outbox in PostgreSQL relayed to BullMQ | Proposed |

## Context

Managed sync must keep the analytical store fresh, correct and recoverable across five very different sources. It must also propagate changes to the vector index and invalidate caches. Native CDC (PostgreSQL logical replication, MySQL binlog, MongoDB Change Streams) is the most efficient option, but often unavailable for SME setups: it needs configuration and privileges customers may not grant, and spreadsheets have no row-level change feed at all. Writing to two stores without coordination risks lost or duplicated updates.

## Decision

1. The sync engine runs in the `worker` process and shares no code path with the AI pipeline.
2. **Strategy by capability** ([sync-engine.md](../data/sync-engine.md)): full snapshot first, then the best available incremental method. The MVP uses timestamp cursors (SQL) and fingerprint diffs (spreadsheets). CDC connectors come later where the source supports and permits them.
3. **Idempotency:** deterministic record identity `(tenant_id, data_source_id, source_object, source_key)` and a `content_hash`. Upserts skip unchanged rows, and replays are safe.
4. **Checkpoints** are committed in the same PostgreSQL transaction as the batch they cover.
5. **Transactional outbox:** the same transaction inserts outbox events (`dataset.version_changed`, `document.changed`, `entity.deleted`). A relay publishes them to BullMQ. Consumers (vector indexer, cache invalidator) are idempotent by event ID.
6. **Deletes:** native where reported, otherwise periodic key-set reconciliation that marks missing keys `deleted_at`.
7. **Schema drift:** compare the schema fingerprint on each run. Additive changes produce a warning. Breaking changes (a mapped field removed or renamed, or an incompatible type change) pause the source and require re-approval.
8. **Failure handling:** bounded retries with exponential backoff and jitter, then a dead-letter record visible to admins. Poison batches are isolated without blocking the rest of the source.
9. **Freshness:** per-dataset `last_successful_sync_at` and `data_version`, exposed to users and to answers.

## Alternatives considered

- **Kafka with Debezium for CDC.** The industry standard for CDC at scale, but heavy infrastructure, and it does not help spreadsheets. Rejected for now (D-09).
- **Dual writes without an outbox.** Simpler, but a crash between writes desynchronizes the stores.
- **CDC first.** Better freshness, but blocked on customer database configuration. It would delay the MVP.

## Advantages

- Works with the lowest-common-denominator source access an SME can grant.
- Crash-safe and replayable. Data and index never diverge permanently.

## Disadvantages

- Polling adds latency (minutes, not seconds) and load on the source.
- Reconciliation over large tables is expensive and must be scheduled.
- Timestamp polling depends on a trustworthy `updated_at` column, which not all schemas have.

## Security implications

- Sync jobs run with tenant context set from the verified job payload.
- Dead-letter records store error metadata and record keys, never full row contents.
- Outbox events carry IDs and versions, not data values.

## Consequences

- An outbox table and relay are needed in Milestone 5, before vector indexing in Milestone 7.
- Every connector must declare its change and delete detection capabilities honestly.

## Revisit conditions

- A pilot customer needs freshness under 5 minutes on a CDC-capable database. Then build that CDC connector.
- Outbox relay throughput becomes a bottleneck (sustained lag above 1 minute). Then evaluate dedicated streaming.
