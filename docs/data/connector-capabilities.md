# Connector capabilities by source

Contract: [contracts/connector/](../../contracts/connector/). Decision: [ADR-0004](../adr/ADR-0004-connector-architecture.md). Not implemented. The "MVP" column reflects [ROADMAP.md](../../ROADMAP.md).

| Capability | Excel (upload) | Google Sheets | PostgreSQL | MySQL | MongoDB |
|---|---|---|---|---|---|
| MVP | Yes | M9 | Yes | Later | Later |
| Access modes | sync | sync | sync, live (later) | sync, live (later) | sync (live: OPEN) |
| Authentication | none (upload) | OAuth 2.0, read-only scopes | user/password, TLS | user/password, TLS | connection string, TLS |
| Schema discovery | header detection, type inference | header detection, type inference | `information_schema` / `pg_catalog` | `information_schema` | sampling-based |
| Stable record key | user-chosen key column | user-chosen key column | primary key | primary key | `_id` |
| Incremental (MVP-era) | file version + row fingerprint | `modifiedTime` + row fingerprint | `updated_at` cursor | `updated_at` cursor | `updatedAt`/`_id` cursor |
| CDC (later) | n/a | n/a | logical replication | binlog (ROW) | Change Streams |
| Delete detection | fingerprint diff | fingerprint diff | reconciliation / CDC | reconciliation / CDC | reconciliation / Change Streams |
| Query pushdown | no | no | SQL | SQL | aggregation pipeline (OPEN) |
| Typical limits | file size cap (to set), multiple tables per sheet | API quotas, cell limits, merged cells | privilege and config constraints for CDC | binlog retention | standalone servers lack Change Streams |

## Required customer-side setup

- **PostgreSQL / MySQL:** a read-only user with `SELECT` on approved tables only. Network reachability from BusinessPilot's egress IPs (published allow-list) or, later, a private connector (D-OPEN-08). Optional: a read replica to avoid load on production.
- **MongoDB:** a read-only user on approved collections. A replica set for future Change Streams.
- **Google Sheets:** OAuth consent with read-only scope. The user selects specific spreadsheets.
- **Excel:** upload through the UI. Files are stored under `tenants/{tenant_id}/uploads/` and retained per policy.

## Connector contract tests (required per connector)

Connection failure modes (bad host, bad credentials, insufficient privileges), schema discovery on a fixture, snapshot paging, incremental change detection, delete detection, schema drift detection, and that no credential appears in logs or errors.
