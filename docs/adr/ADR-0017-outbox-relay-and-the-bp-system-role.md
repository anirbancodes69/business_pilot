# ADR-0017: Outbox relay and the `bp_system` role

- **Status:** Proposed
- **Date:** 2026-11-14
- **Decision items:** P-22 (new). Builds on P-06 (transactional outbox) and P-15 (b) (the `bp_system` exception). Needs product owner confirmation before it is built.

| Item | Status |
|---|---|
| P-22 The outbox relay and the sync scheduler find work through a tenant list read as `bp_system`, and touch tenant data only in per-tenant jobs that run as `bp_app` | Proposed |

## Context

Milestone 5 writes outbox events (`dataset.version_changed`) in the same transaction as the data (P-06). Something must read those events and publish them to a queue, and a scheduler must start syncs on a timetable. Both start without a tenant: they must find out which tenants have work.

Under forced RLS, `bp_app` sees nothing without a tenant context. P-15 (b) already allows a `bp_system` role for exactly this ("outbox relay, scheduler, retention sweeps"), but it was written as a short sentence. [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql) lists `outbox_event`, `sync_job` and `dataset` as the tables it may read and update. That list is wider than needed, the role has no login yet, and the table names are out of date (the sync tables are `sync_run`, `dataset`, `outbox_event`). This ADR fixes the details. It adds no new RLS exception beyond P-15.

## Decision

1. **`bp_system` reads only the tenant list.** Its existing grant (`SELECT (id, status)` on `core.tenant`, `UPDATE (status)`) is enough. It gets **no grant** on `outbox_event`, `dataset`, `sync_run` or any other table. This narrows the list in SECURITY.md §4.
2. **Two kinds of work, both per tenant.** A *sweeper* in the worker runs as `bp_system`, lists active tenants and enqueues one job per tenant (`relay` or `schedule`, job ID `kind_{tenant_id}_{minute}` so repeats collapse). The per-tenant job runs as `bp_app` with `SET LOCAL app.tenant_id`, exactly like a sync job. Outbox rows and data sources are therefore only ever read under RLS for one tenant.
3. **Two triggers for the relay.** After a sync commits, the sync worker enqueues that tenant's `relay` job at once (low latency). The sweeper repeats it every 60 seconds for every tenant (safety net for a crash between commit and enqueue). The scheduler runs every minute and starts the syncs that are due ([sync-engine.md](../data/sync-engine.md) lists the default intervals).
4. **The relay publishes to a queue.** It reads a tenant's unpublished events with `FOR UPDATE SKIP LOCKED`, adds one BullMQ job per event to an `events` queue with the **event ID as the job ID** (a duplicate add is ignored), then sets `published_at` in the same transaction. A crash after the add and before the commit publishes the event twice with the same ID. Delivery is therefore at least once, and consumers de-duplicate by event ID.
5. **Events are a trigger, never the source of truth.** Cache correctness uses `data_version` in the cache key (ADR-0007). The vector index can be rebuilt from stored state. Losing an event delays an optimization; it never returns a wrong answer. Until a consumer exists (M6 cache invalidation, M7 indexing), event types with no subscriber are marked published without being queued, so nothing piles up in Redis.
6. **Retention.** Published events older than 7 days are deleted by the per-tenant job. `bp_app` gets `DELETE` on `core.outbox_event` through a policy that allows it only where `published_at IS NOT NULL`.
7. **Login for `bp_system`.** The role gets `LOGIN` and a password (`POSTGRES_SYSTEM_PASSWORD`) in `infrastructure/postgres/init/01-roles.sh`, and a separate connection used only by the sweeper. The init script runs only on an empty data directory, so existing local stacks need `down -v` once. For a hosted database the operator sets the login and password as a deployment step, because `bp_owner` has no `CREATEROLE`. The `api` process does not get this password, only the `worker`.
8. **Tests.** The tenant isolation suite (TI-15) is extended: `bp_system` can list tenant IDs and status and nothing else, and a per-tenant relay job never reads another tenant's events.

## Alternatives considered

- **`bp_system` reads `outbox_event` across tenants.** The SECURITY.md wording. Simplest and fastest (one query for all tenants). Rejected: the role would read rows from every tenant (IDs and versions only, but still tenant data), and a bug in it would leak across tenants. The per-tenant design costs one tenant-list query per sweep.
- **Publish after commit from the sync worker only, with no sweeper.** No new role. Rejected: a crash between commit and publish loses the event for good, which the outbox exists to prevent.
- **`LISTEN/NOTIFY` or logical decoding of the outbox table.** Efficient, but it needs a long-lived connection or a replication role, and many managed PostgreSQL offerings restrict both. Rejected for now.
- **Kafka or Debezium.** Excluded by D-09.
- **Skip the queue: consumers read the outbox directly.** Fewer moving parts. Rejected: the outbox table would become a shared work queue with several consumers' state, and BullMQ already gives retries and back-off.

## Advantages

- `bp_system` stays almost powerless: it can list tenants and nothing else.
- Every read of tenant data happens under RLS for exactly one tenant, using the same code path as sync jobs.
- At-least-once delivery with a stable event ID is simple for consumers to make safe.

## Disadvantages

- A sweep costs one job per tenant per minute, even for idle tenants. It is cheap per tenant but grows linearly (hundreds of tenants: fine; many thousands: needs batching or an "active tenants" hint).
- Latency is about the job hop (seconds) on the fast path and up to a minute on the safety net.
- A new password and a role login to manage.

## Security implications

- No new RLS exception. P-15 (b) is narrowed (point 1), not widened.
- Event payloads hold IDs, versions and entity names only, never values (ADR-0005). Job payloads hold the tenant ID and event ID.
- The sweeper credential exists only in the worker's environment. Logs carry tenant IDs and counts, never row data.
- The `DELETE` policy on published events cannot remove an unpublished event, so a bug cannot silently drop pending work.

## Consequences

- E5.4 (relay) and the sync scheduler (E5.5) follow this design once it is accepted.
- SECURITY.md §4, `infrastructure/postgres/README.md` and ADR-0014's remark that `bp_system` "can read and update tenant status only" are updated when this is accepted. The existing local volume must be recreated once.
- M6 and M7 consumers must de-duplicate by event ID.

## Revisit conditions

- A sweep takes longer than 10 seconds or runs behind by more than a minute (many tenants). Then batch tenants or track which ones have pending events.
- Event volume needs lower latency than a minute on the safety net, or sustained lag above one minute on the fast path (also the trigger in ADR-0005).
- A hosted database cannot give `bp_system` a login. Then reconsider the design (for example a separate platform service).
