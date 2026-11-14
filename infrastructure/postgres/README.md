# infrastructure/postgres

**Status: implemented for Milestone 2.** `init/01-roles.sh` runs once on first start as a bootstrap superuser (administration only) and creates `bp_owner` (database owner, runs migrations), `bp_app` (runtime) and `bp_system` (logs in with `POSTGRES_SYSTEM_PASSWORD`; used by the worker sweeper only, ADR-0017). None of them is a superuser or has BYPASSRLS. Grants, schemas, tables and RLS policies come from the migrations in `apps/api/src/migrations`. `bp_platform` is not created yet. Changing the init script needs a fresh data volume (`down -v`). Application migrations live in `apps/api`.

Required roles (see [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql)):

| Role | Purpose | Must NOT have |
|---|---|---|
| `bp_owner` | Owns schemas and tables. Runs migrations | Use by application at runtime |
| `bp_app` | Runtime role for api and worker | Table ownership, `BYPASSRLS`, superuser |
| `bp_system` | Worker sweeper: lists tenant id and status (P-15, ADR-0017) | Any grant on `analytics` or on any table other than `core.tenant` (id, status) |
| `bp_platform` | Audited cross-tenant operations (later) | Use in the request path |

Schemas: `core` (control plane) and `analytics` (canonical tenant data). Every tenant table has RLS enabled and forced.
