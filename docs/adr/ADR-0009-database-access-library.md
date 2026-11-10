# ADR-0009: Database access library and migration tool

- **Status:** Accepted (confirmed by the product owner, 2026-11-11)
- **Date:** 2026-11-11
- **Decision items:** D-13 (formerly D-OPEN-16)

## Context

`apps/api` must run tenant-scoped queries inside transactions that start with `SET LOCAL app.tenant_id` (`withTenantTx`, [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql)). It must also compile validated `QueryPlan`s into parameterized SQL at runtime (P-03). RLS policies, roles and grants are SQL-level concerns. ADR-0008 rules out ORMs that hide SQL in the data-access module.

## Decision

Use **Kysely** as the query builder and its built-in **Migrator** for forward-only migrations in `apps/api`, with the `pg` driver.

- Migrations are TypeScript files that run raw SQL where needed. Roles, RLS policies, `FORCE ROW LEVEL SECURITY` and grants are written as raw SQL.
- Only the `platform` module imports the Kysely instance or the pool. All other modules receive a transaction handle from `withTenantTx` (lint rule, see [DEVELOPMENT.md](../../DEVELOPMENT.md)).
- Migrations run as `bp_owner`. The application connects as `bp_app`.
- Table types are kept in sync with the database by a generated or hand-reviewed type file. The method is chosen when the first migration is written.

## Alternatives considered

- **Drizzle.** Strong TypeScript schema definition and migration generation. Less suited to dynamically composed SQL, and its generated migrations do not cover RLS and roles, so those would be hand-written anyway.
- **Prisma, TypeORM, MikroORM.** ORMs that hide SQL and make per-transaction `SET LOCAL` and dynamic query compilation harder. Excluded by ADR-0008.
- **Raw `pg` only.** Maximum control, but no type safety for the plan compiler.

## Advantages

- Explicit SQL, composable for the plan compiler, typed results.
- Transaction handles make it simple to guarantee that every query runs inside `withTenantTx`.

## Disadvantages

- Types are not generated automatically from the schema (needs a type-generation step or manual upkeep).
- The Migrator is simple: no automatic down-migrations or diffing. This matches the forward-only rule.

## Security implications

- Kysely parameterizes values. Raw SQL fragments (`sql` template tag) must use bound parameters only and are reviewed. No string-built SQL from model output (rule 5 in CLAUDE.md).
- Tenant isolation does not depend on the library. It depends on RLS and `withTenantTx`, and is tested by TI-01 to TI-05.

## Consequences

- Milestone 1 adds Kysely and `pg` to `apps/api`. Milestone 2 writes the first migrations and `withTenantTx`.
- Each new package needs its one-line justification in the PR (CLAUDE.md).

## Revisit conditions

- Type maintenance becomes a recurring source of defects.
- The plan compiler needs features Kysely cannot express without heavy raw SQL.
