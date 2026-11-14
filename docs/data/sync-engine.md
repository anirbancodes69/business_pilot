# Sync engine design

Decision: [ADR-0005](../adr/ADR-0005-synchronization-architecture.md).

**Implemented (Milestone 5, in progress, 2026-11-14):** full-snapshot sync through BullMQ (`apps/api/src/sync/`): idempotent upserts with content hash, reference resolution, dead letters, one running sync per source, `data_version` bump once per run with an outbox event written in the same transaction, per-batch checkpoints, run history and dataset freshness endpoints. The Excel and PostgreSQL connectors implement `readSnapshot`. A full snapshot restarts from the beginning after a crash (safe, because upserts are idempotent). **Not implemented yet:** incremental reads (cursor, fingerprint diff), delete propagation, schema drift detection, the outbox relay, scheduling, the admin alert and the UI. Everything below describes the target design.

## Concepts

- **Sync job:** the configured schedule for one data source, covering all its active mapped objects.
- **Sync run:** one execution. States: `queued` → `running` → `succeeded` | `partially_failed` | `failed` | `paused`.
- **Checkpoint:** per `(data_source, source_object)`. This is an opaque connector cursor: a timestamp + key, an LSN, a binlog position, a resume token or a file fingerprint set.
- **Dataset:** a canonical entity's data from one source. It has a `data_version` (a monotonic integer) and `last_successful_sync_at`.

## Run algorithm (managed sync)

```
for each active mapped object:
  load checkpoint (null → full snapshot)
  check schema fingerprint vs mapping version
    additive drift  → warn, continue
    breaking drift  → mark mapping needs_review, pause object, alert admin, skip
  stream batches from readSnapshot/readChanges
    for each batch, in ONE transaction with SET LOCAL app.tenant_id:
      transform via mapping → canonical rows (+ content_hash)
      UPSERT ON CONFLICT (tenant_id, data_source_id, source_object, source_key)
             DO UPDATE ... WHERE content_hash differs
      apply deletes reported by the connector (set deleted_at)
      save checkpoint
      if any row changed: data_version += 1 (once per run) and insert outbox event
  on schedule (e.g. nightly or weekly per size): reconciliation
    listKeys() at source vs active keys in store → mark missing as deleted_at
```

## Idempotency and duplicate prevention

- Record identity is deterministic, so upsert replays are harmless.
- The `content_hash` comparison avoids no-op writes and false `data_version` bumps.
- BullMQ job ID = `sync:{data_source_id}:{scheduled_at}` prevents duplicate scheduling. A per-source lock (one running sync per source) prevents overlap.
- Outbox consumers record processed event IDs.

## Retry, dead-letter and recovery

| Failure | Handling |
|---|---|
| Transient (network, timeout, rate limit) | Retry the batch with exponential backoff and jitter, max 5 attempts, honouring source rate-limit hints |
| Bad records (transform error) | Write to `sync_dead_letter` (keys + error, no row contents). Continue the batch. The run ends `partially_failed` |
| Authentication or privilege failure | Fail the run, mark the data source `needs_attention`, notify the admin. No retries |
| Lost checkpoint / expired CDC position | Fall back to a full snapshot with a reconciliation pass |
| Worker crash | The run is resumed from the last committed checkpoint. Uncommitted batches are re-read |

## Outbox

```
core.outbox_event(id uuid, tenant_id, type, aggregate_ref, payload jsonb /* ids, versions only */,
                  created_at, published_at null)
```

The relay (worker) polls unpublished events with `FOR UPDATE SKIP LOCKED`, publishes them to BullMQ, and sets `published_at`. Delivery is at-least-once, and consumers are idempotent. Event types: `dataset.version_changed`, `document.changed`, `mapping.activated`, `semantic_model.published`, `tenant.deletion_requested`.

## Freshness

Each `dataset` exposes `last_successful_sync_at`, `last_attempt_at`, `status` and `data_version`. The cache policy and AI configuration define a freshness threshold per tenant. Answers include the freshness of every dataset they used, and flag datasets older than the threshold.

## Schedules (defaults, configurable)

Excel: on upload. Google Sheets: every 30 minutes, or on detected file change. PostgreSQL and MySQL polling: every 15 minutes. Reconciliation: daily for tables under 1M rows, weekly above that. These are initial values to tune during pilots.
