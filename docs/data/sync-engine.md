# Sync engine design

Decision: [ADR-0005](../adr/ADR-0005-synchronization-architecture.md).

**Implemented (Milestone 5, 2026-11-14):** sync through BullMQ (`apps/api/src/sync/`): idempotent upserts with content hash, reference resolution, dead letters (and an endpoint to read them), one running sync per source, `data_version` bump once per run with an outbox event written in the same transaction, per-batch checkpoints, run history and dataset freshness endpoints. PostgreSQL syncs incrementally with a timestamp cursor (`>=` the last committed value, so boundary rows are re-read and skipped by hash) when the mapping names `updated_at_field`. A full read happens first, after any mapping change, and for Excel (which re-reads the file and skips unchanged rows). Deletes are found by key-set reconciliation: on every full read, and during incremental runs once the last one is older than 24 hours. A full read that returns no rows while rows are stored is refused (`source_empty`). No deletes are made when two objects feed one entity. A breaking schema change (missing object, key or mapped column, or a changed type on a catalog source) pauses the object, sets its mapping to `needs_review`, the dataset to `paused` and writes an audit event; additive changes are counted as warnings. The outbox relay and the scheduler follow [ADR-0017](../adr/ADR-0017-outbox-relay-and-the-bp-system-role.md): a sweeper (as `bp_system`, tenant list only) queues per-tenant relay and schedule tasks every minute, which run as `bp_app`; a finished sync queues a relay task at once. PostgreSQL sources sync every 15 minutes; Excel on upload and on mapping activation. Administrators get notifications (`GET /v1/notifications`) for schema-drift pauses and failed or unauthorized syncs, and datasets report a `stale` flag (older than 24 hours, a fixed default until M6 adds a per-tenant setting). **Not implemented:** the UI (moved to Milestone 9, E9.1), event consumers (M6 and M7), and the re-approval flow for a paused mapping beyond the M4 endpoints (suggest and approve it again). A full read still restarts from the beginning after a crash (safe because upserts are idempotent). Everything below describes the target design.

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
