# infrastructure/redis

**Status: running in Compose (no application client yet).** Redis Stack (search and vector) is used for BullMQ queues, the exact cache, the semantic plan cache and per-tenant vector indexes.

Key conventions: `t:{tenant_id}:...` for all tenant data, `idx:t:{tenant_id}:{name}` for indexes, `bull:{queue}` for queues (job payloads always include `tenant_id`). Configuration (P-14): `maxmemory-policy noeviction`, as BullMQ requires, and AOF persistence enabled, because queued jobs are not disposable. Every cache key has a TTL. Authentication is required in every environment, with TLS outside local development. Check the license before redistribution ([ADR-0008](../../docs/adr/ADR-0008-technology-selection.md)).
