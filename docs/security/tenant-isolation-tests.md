# Mandatory tenant isolation tests

These tests are **mandatory engineering requirements** ([SECURITY.md §10](../../SECURITY.md#10-mandatory-tenant-isolation-tests)). TI-01 to TI-05 and TI-15 are implemented (and extended for `core.semantic_model` in M3: cross-tenant read, edit and publish give 404, a forged tenant gives 403, published documents are immutable in the database) in `apps/api/test/isolation/` and run in CI as the `tenant-isolation` job (`pnpm test:isolation`, needs a real PostgreSQL). TI-10 is covered at unit level (signature, expiry, request_id binding) in `apps/api/test/request-context.test.ts`. The rest are added in the milestones below. Each must be automated, run in CI, and block merges when failing.

Fixture: tenants **A** and **B** with deliberately overlapping natural keys (same customer codes, invoice numbers and branch names) and different values, so a leak is visible in results. Within tenant A: users with roles owner, finance_manager, sales_manager (branch 1 only) and sales_executive.

| ID | Test | Layer | Milestone |
|---|---|---|---|
| TI-01 | With no `app.tenant_id` set, selects on every RLS table return 0 rows, and inserts fail | DB | M2 |
| TI-02 | With tenant A's context set, no query against any tenant table returns tenant B's rows. This is generated over **all** tables from the catalog, so new tables are covered automatically | DB | M2 |
| TI-03 | Tenant context does not leak across pooled connections: run tenant A's transaction then tenant B's on the same connection, and assert separation; check that no session-level `SET` is used | DB / app | M2 |
| TI-04 | Catalog check: every table in `core` (except the allow-list) and in `analytics` has `tenant_id`, RLS enabled **and forced**, and a policy. The app role is not an owner and has no `BYPASSRLS` | DB | M2 |
| TI-05 | API: a user of tenant A calling any endpoint with tenant B's resource IDs, or with a forged tenant header or body field, gets 404/403 | API | M2 |
| TI-06 | Vector search through `retrieve-context` with tenant A's context never returns tenant B's content, even with an identical query text | Redis | M7 |
| TI-07 | Exact and semantic caches: tenant B or a user with a narrower scope asking an identical question gets no hit from tenant A's or a broader scope's entries | Cache | M6/M8 |
| TI-08 | Jobs: a job payload with tenant A's ID that references tenant B's data source fails ownership checks and does not run | Worker | M5 |
| TI-09 | `execute-plan` with a valid RequestContext for tenant A but a plan referencing measures or dimensions outside the user's view is rejected and audited | API / AI | M6 |
| TI-10 | A RequestContext that is expired, has a tampered signature or is replayed against a different `request_id` is rejected | API | M6 |
| TI-11 | Prompt injection: questions and synced text fields that contain instructions to access tenant B or other branches yield no extra data (also in the AI adversarial evaluation set) | AI | M6 |
| TI-12 | Object storage: tenant A cannot read tenant B's upload keys through any API | Storage | M4 |
| TI-13 | Tenant deletion removes tenant data from PostgreSQL, Redis keys and indexes, object storage and credentials, and leaves other tenants untouched | All | M9/M10 |
| TI-14 | ABAC: sales_manager (branch 1) gets only branch 1 rows for every measure, including through cache hits | API / DB | M3/M6 |
| TI-15 | RLS exceptions stay narrow: with only `app.user_id` set, a user sees only their own `tenant_membership` rows and nothing in any other table; the `bp_system` role cannot select from any `analytics` table or from non-allow-listed `core` tables | DB | M2 |

Adding a new tenant-owned store, table, cache or job type requires adding or extending a test in this list in the same PR.
