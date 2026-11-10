# infrastructure/postgres

**Status: partial.** `init/01-roles.sh` creates only the `bp_app` login role (no superuser, no BYPASSRLS) on first start. In the local image `bp_owner` is the bootstrap superuser. The full role model, grants and RLS are Milestone 2. Application migrations live in `apps/api`.

Required roles (see [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql)):

| Role | Purpose | Must NOT have |
|---|---|---|
| `bp_owner` | Owns schemas and tables. Runs migrations | Use by application at runtime |
| `bp_app` | Runtime role for api and worker | Table ownership, `BYPASSRLS`, superuser |
| `bp_system` | Worker system tasks: outbox relay, sync scheduler, retention sweeps (P-15) | Any grant on `analytics`; tables beyond the named control-plane set |
| `bp_platform` | Audited cross-tenant operations (later) | Use in the request path |

Schemas: `core` (control plane) and `analytics` (canonical tenant data). Every tenant table has RLS enabled and forced.
