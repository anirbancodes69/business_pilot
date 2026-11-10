# ADR-0003: Tenant isolation

- **Status:** Accepted (D-03, D-04, D-05, the layered model). Proposed (P-01, P-08, P-12, the mechanisms). OPEN (D-OPEN-05, the policy engine).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-03 Layered isolation; shared infrastructure ≠ shared authorization | Accepted |
| D-04 The LLM never decides permissions | Accepted |
| D-05 RBAC + ABAC | Accepted |
| P-01 Pooled tenancy: shared schema with `tenant_id` and forced RLS | Proposed |
| P-08 One Redis vector index per tenant | Proposed |
| P-12 Envelope encryption of connector credentials | Proposed |
| P-15 Two defined RLS exceptions: membership lookup by `app.user_id`; `bp_system` role for worker system tasks with no `analytics` access | Proposed |
| D-OPEN-05 Policy engine | OPEN |

## Context

Many businesses share one installation in Model A. A single cross-tenant leak of financial data would be fatal to the product. The risk is higher than in typical SaaS because an LLM creates new paths into data, through prompt injection and generated queries. Isolation cannot rest on one mechanism or on developer discipline alone.

## Decision

Isolation is enforced in independent layers. Each layer must hold even if the one above it fails:

1. **Identity and membership.** The active tenant comes from the authenticated session plus a membership check, and nowhere else.
2. **Application authorization.** RBAC + ABAC produce an `AuthorizationContext` before any AI call (D-04, D-05). It is re-checked when plans execute. Default deny.
3. **Database.** Pooled tenancy (P-01): `tenant_id` on every tenant table, RLS enabled and forced, `SET LOCAL app.tenant_id` per transaction, an application role with no ownership or `BYPASSRLS`. Two exceptions are needed and are kept deliberately narrow (P-15, [SECURITY.md §4](../../SECURITY.md#4-tenant-isolation-in-postgresql)): users can list their own memberships before a tenant is selected, and a `bp_system` role can run cross-tenant worker scheduling on control-plane tables only.
4. **Non-relational stores.** Tenant-prefixed Redis keys behind a single wrapper. A per-tenant vector index (P-08) that also filters on a `tenant_id` tag. Tenant-prefixed object storage keys.
5. **Asynchronous work.** Job payloads carry `tenant_id`. Workers re-establish tenant context and check ownership of referenced entities.
6. **Caches.** Keys include tenant and `authz_scope_hash` ([ADR-0007](ADR-0007-caching-strategy.md)).
7. **Verification.** The mandatory isolation suite ([tenant-isolation-tests.md](../security/tenant-isolation-tests.md)) blocks merges.

Policies are typed, versioned configuration evaluated in code for the MVP (D-OPEN-05).

## Alternatives considered

- **Schema per tenant.** Stronger separation, but migrations fan out per tenant, connection and search_path handling gets complex, and analytics across templates is harder. A possible tier for large tenants later.
- **Database per tenant.** Strongest isolation, highest cost. Suits Model B or premium tiers, not SME SaaS.
- **Application-only filtering (no RLS).** One missing `WHERE` clause leaks data. Rejected.
- **A shared vector index with a tag filter only.** Cheaper at large tenant counts, but a filter bug leaks. Kept as defence in depth inside per-tenant indexes.
- **Policy engines (OPA, Cedar) now.** More capability than MVP policies need. Revisit when tenants author their own policies.

## Advantages

- Defence in depth. RLS catches application bugs, and the application catches RLS misconfiguration.
- Pooled tenancy keeps cost per tenant low and migrations simple.

## Disadvantages

- RLS adds a planning cost on queries, and all `tenant_id` indexes must lead with `tenant_id`.
- `SET LOCAL` discipline means every query must run inside a transaction helper.
- Per-tenant vector indexes add overhead as the tenant count grows.

## Security implications

This ADR *is* the core security control. Residual risks: superuser or owner misuse (mitigated by separating roles and auditing), side channels through timing or aggregate counts (low for this domain), and noisy neighbours (mitigated by quotas and timeouts).

## Consequences

- Every tenant table PR includes its RLS policy and isolation test.
- Platform-level cross-tenant operations need a separate audited path.

## Revisit conditions

- A customer contract requires physical isolation. Then offer schema-per-tenant, database-per-tenant or Model B.
- More than about 1,000 tenants, or measurable Redis memory overhead from per-tenant indexes. Then reconsider P-08.
- Tenants need self-authored policies. Then decide D-OPEN-05.
