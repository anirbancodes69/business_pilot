# apps/api — NestJS modular monolith

**Status: not started** (see [CURRENT.md](../../CURRENT.md)). Scaffolded in Milestone 1.

One codebase, two process types:

- `main.ts`: the HTTP API (public REST, plus internal tool endpoints for ai-engine)
- `worker.ts`: BullMQ consumers (sync, outbox relay, vector indexing, reconciliation, retention)

Proposed modules: identity, tenancy, authorization, configuration, semantic-model, connectors, sync, data-access (plan compiler, execution, exact cache, retrieval), conversations, audit, platform (crypto, storage, outbox, telemetry, tenant-aware DB and Redis wrappers).

Read before coding: [SECURITY.md](../../SECURITY.md), [DATA_CONNECTIVITY.md](../../DATA_CONNECTIVITY.md), [docs/ai/orchestration-pipeline.md](../../docs/ai/orchestration-pipeline.md#plan-compiler-in-the-api-not-in-ai-engine).
