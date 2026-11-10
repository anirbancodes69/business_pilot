# infrastructure/postgres

**Status: not started.** Will hold local initialization scripts (roles and extensions). Application migrations live in `apps/api`.

Required roles (see [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql)):

| Role | Purpose | Must NOT have |
|---|---|---|
| `bp_owner` | Owns schemas and tables. Runs migrations | Use by application at runtime |
| `bp_app` | Runtime role for api and worker | Table ownership, `BYPASSRLS`, superuser |
| `bp_system` | Worker system tasks: outbox relay, sync scheduler, retention sweeps (P-15) | Any grant on `analytics`; tables beyond the named control-plane set |
| `bp_platform` | Audited cross-tenant operations (later) | Use in the request path |

Schemas: `core` (control plane) and `analytics` (canonical tenant data). Every tenant table has RLS enabled and forced.
