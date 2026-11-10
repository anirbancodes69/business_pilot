# DATA_CONNECTIVITY.md — Connectors, storage and synchronization

Nothing here is implemented yet. Details: [docs/data/connector-capabilities.md](docs/data/connector-capabilities.md), [docs/data/canonical-model.md](docs/data/canonical-model.md), [docs/data/sync-engine.md](docs/data/sync-engine.md). Contract: [contracts/connector/](contracts/connector/).

## 1. Connector framework

Every source type implements one interface (P-04, [ADR-0004](docs/adr/ADR-0004-connector-architecture.md)):

| Operation | Purpose |
|---|---|
| `describeCapabilities()` | Static capability descriptor: access modes, change detection methods, delete detection, pushdown support, limits |
| `testConnection(config, credentials)` | Validate reachability, authentication and privileges, and warn about excess privileges |
| `discoverSchema()` | List objects (tables, collections, sheets) with fields, types, keys, sample statistics, and a schema fingerprint |
| `readSnapshot(object, options)` | Full extraction as a stream of record batches |
| `readChanges(object, checkpoint)` | Incremental changes since a checkpoint, with a new checkpoint |
| `listKeys(object)` | Primary key set, used for reconciliation and delete detection |
| `executeFederated(query)` | Optional. Run a compiled, read-only query at the source (live mode) |

Connectors are stateless. Checkpoints, credentials and configuration are passed in by the sync engine. Connectors run inside the api/worker process. A separately deployed private connector agent is D-OPEN-08.

Initial connectors: **Excel** (upload first, cloud drives later), **Google Sheets**, **PostgreSQL**, **MySQL**, **MongoDB**. New connectors are added by implementing the interface and publishing a capability descriptor. Core code needs no changes.

## 2. Data access modes

| | Mode 1: Live / federated | Mode 2: Managed synchronization |
|---|---|---|
| Where data lives | Stays at the source | Approved subset copied into the tenant-isolated analytical store |
| How queries run | Plan compiled to the source dialect and run at the source, read-only | Plan compiled to SQL against `analytics.*` |
| Freshness | Live | As of the last sync (shown in answers) |
| Load on the source | Per question | Per sync |
| Joins across sources | Not supported | Supported |
| Caching | Exact cache off by default, or short TTL only | Full exact caching keyed on data version |
| MVP | No (D-OPEN-07) | **Yes** |

The mode is chosen **per data source**, so one tenant can mix modes. Spreadsheets are sync-only. Live mode does not suit them: there is no query pushdown and their API quotas are tight.

## 3. Storage

- **Structured analytical store: PostgreSQL** (`analytics` schema). Holds canonical entities, upserts, joins, aggregation, soft-delete markers and optional snapshots (for example daily inventory snapshots). RLS is forced on every table ([SECURITY.md](SECURITY.md#4-tenant-isolation-in-postgresql)).
- **Vector store: Redis Stack** (candidate; D-OPEN-06). Holds embeddings of approved glossary terms, metric definitions, schema and column descriptions, policies and documents. Each vector stores `tenant_id`, `source_ref`, `semantic_model_version`, `embedding_model` and `content_hash`.

**Why they are separate** ([ADR-0002](docs/adr/ADR-0002-data-storage-strategy.md)): financial answers need exact aggregation, filtering and joins over complete record sets. Nearest-neighbour search is approximate and returns the top-k similar items, so it cannot sum invoices correctly. The vector store helps the AI understand *what the user means* (which metric, which entity, which policy). The relational store computes *what the numbers are*. Financial and personal records are not embedded by default (D-02).

## 4. Canonical business representation

Source schemas are mapped into **industry templates** of canonical entities. The first template, `wholesale_distribution v0`, has Customer, Product, Invoice, InvoiceLine, Payment, Order, Inventory, Branch and Supplier. Templates are starting points. A tenant activates only the entities it has. Tenant-specific attributes go in the JSONB `ext` column (P-11).

Mapping lifecycle (D-10):

```
discovered ─▶ suggested (AI-assisted) ─▶ in_review ─▶ approved ─▶ active
                                      └─▶ rejected            └─▶ superseded
```

Only `active` mappings feed sync. Activating a mapping or changing it in a breaking way creates a new semantic model version. Details: [docs/data/canonical-model.md](docs/data/canonical-model.md). Schema: [schemas/configuration/entity-mapping.schema.json](schemas/configuration/entity-mapping.schema.json).

## 5. Synchronization engine (summary)

The sync engine is independent of the AI pipeline (D-06). It runs in the `worker` process using BullMQ.

- Initial full ingestion, then incremental sync using the best change-detection method each source supports.
- Idempotent upserts keyed by `(tenant_id, data_source_id, source_object, source_key)`, with a content hash so unchanged records are skipped.
- Checkpoints are committed in the **same transaction** as the data they cover.
- A transactional outbox (P-06) emits `dataset.version_changed` and `document.changed` events for vector indexing and cache invalidation.
- Deletions: native where the source reports them, otherwise by key-set reconciliation.
- Schema drift: additive changes produce a warning. Breaking changes pause the source and require re-approval.
- Retries with exponential backoff, then dead-letter. Per-dataset freshness is reported to users.

### Source-specific strategy

| Source | Preferred change detection | Fallback | Delete detection | Key limitations |
|---|---|---|---|---|
| PostgreSQL | Logical replication (post-MVP) | `updated_at` cursor + keyset pagination | Logical replication, or key-set reconciliation | Logical replication needs `wal_level=logical`, a replication role and a publication. Many SME and managed setups cannot provide these. Polling misses hard deletes and needs a reliable `updated_at` column. |
| MySQL | Row-based binlog CDC (post-MVP) | `updated_at` cursor | Binlog, or reconciliation | Needs `binlog_format=ROW`, replication privileges and enough binlog retention. Older or shared hosting may not allow it. |
| MongoDB | Change Streams (post-MVP) | `_id`/`updatedAt` polling | Change Streams, or reconciliation | Change Streams need a replica set or sharded cluster (not standalone), and a resume token inside the oplog window. Schemaless documents need sampling-based discovery. |
| Google Sheets | No row-level change feed. Detect file-level changes (Drive `modifiedTime`), then compare row fingerprints | Scheduled full read with fingerprint diff | Fingerprint diff on a user-chosen key column | Rows have no stable IDs, so the user must choose a key column. API quotas apply. Formatting and merged cells cause noise. |
| Excel | Upload: each upload is a new file version, compared by sheet and row fingerprints. Cloud drive (later): file-level change notifications | Re-upload | Fingerprint diff on a key column | Same key-column requirement. Inconsistent headers and multiple tables per sheet need mapping help. |

Full design: [docs/data/sync-engine.md](docs/data/sync-engine.md).
