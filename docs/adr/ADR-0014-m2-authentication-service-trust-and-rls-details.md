# ADR-0014: Authentication, service trust and RLS details (Milestone 2)

- **Status:** Proposed (awaiting product-owner confirmation). Resolves D-OPEN-03 and D-OPEN-15 as recommendations.
- **Date:** 2026-11-13
- **Decision items:** P-18, P-19, P-20 (previously D-OPEN-03 and D-OPEN-15). The identity provider vendor stays OPEN (D-OPEN-03b).

## Context

Milestone 2 needs users to sign in, a way to choose the active tenant, and a way for the api and the ai-engine to trust each other. It also had to turn the RLS design in SECURITY.md into working database code, which raised a few details the documents did not settle.

## Decision

1. **P-18 Authentication.** Users sign in through an external OIDC provider. The api verifies the bearer access token (issuer, audience, signature, expiry) with the `jose` library. Only the subject, email and name are read. Tenant or role claims in the token are ignored. The api owns users, memberships and roles. Which vendor to use is still open. Any standards-compliant provider works, and the api only needs an issuer URL and a client ID. With no provider configured, every authenticated route returns 401 (fail closed).
2. **Active tenant selection.** The client sends `X-Tenant-Id` as a request to act in that tenant. The api accepts it only if the authenticated user has an active membership there, and the tenant is active. A tenant the user does not belong to and a tenant that does not exist both give the same 403. Roles and scope are always computed server-side.
3. **P-19 Service trust (MVP).** The api and ai-engine share a service token for internal endpoints. Each question carries a RequestContext: claims signed with HMAC-SHA256, valid for 2 minutes, bound to the request ID. Several keys can be configured, so a new key can be introduced while the old one still verifies (rotation). The api reloads authorization from its own state and never trusts permissions inside the token. Stronger schemes (mutual TLS, asymmetric keys) are for the customer-hosted edition.
4. **P-20 RLS implementation details.**
   - Tenant context is set with `set_config('app.tenant_id', value, true)`. This is the same as `SET LOCAL` (it lasts only for the transaction), but it accepts a bound parameter. Context helper functions treat an empty string as "no context", because a pooled connection keeps an empty string after a transaction-local setting expires.
   - `core.app_user` (global identity) and `core.permission` (global catalog) hold no tenant data and have no RLS. They are the only tables outside RLS, and the isolation test TI-04 enforces that list. These are not exceptions to tenant isolation. The application accesses `app_user` only through the identity module.
   - The local database has a separate bootstrap superuser used only for administration. `bp_owner` owns the database and runs migrations but is not a superuser. `bp_app` and `bp_system` cannot bypass RLS. `bp_system` has no login until the worker needs it (Milestone 5), and it can read and update tenant status only.
   - System roles and permissions are seeded by a migration that switches FORCE off for the two role tables during that migration only.
   - Tenant provisioning runs under the new tenant's own context, so no bypass is needed.

## Alternatives considered

- **Build our own login.** Slow, and security-sensitive. Rejected.
- **mTLS between services now.** Stronger, but needs certificate handling in Compose and CI. Deferred to the customer-hosted edition.
- **A SECURITY DEFINER function for user lookup.** Forced RLS applies to the function owner too, so this would need a bypass. A plain global identity table is simpler and keeps the number of exceptions small.

## Advantages

- No password handling, and MFA comes from the provider.
- A compromised or tricked ai-engine cannot widen scope: tenant and scope come only from the signed context and the api's own state.
- The isolation suite reads the catalog, so new tables are checked automatically.

## Disadvantages

- Shared secrets need rotation procedures.
- The provider adds a dependency and a cost.
- The global `app_user` table can be read by any code that has a database handle. A lint rule and review keep access inside the identity module.

## Security implications

- Tokens, request contexts and service tokens are never logged. Config errors name variables only.
- Audit events are written in the same transaction as the change they describe, and the application role cannot update or delete them.

## Consequences

- Moving to Accepted needs the owner's confirmation and the choice of provider vendor.
- ai-engine will verify nothing itself. It passes the token back, so the signing key stays in the api.
- `contracts/tenant/request-context.schema.json` still says the signing scheme is OPEN. Its description should be updated when this ADR is accepted.

## Revisit conditions

- Customer-hosted deployments need their own identity provider or stronger service authentication.
- A pilot customer requires single sign-on that the chosen provider cannot support.

## Addendum 2026-11-14: what an access policy may grant (D-16, Accepted)

Found by the Milestone 1 to 4 audit. The access policy document lets a role be given non-data permissions (`role_grants[].permissions`). These were not checked, so anyone holding `tenant:manage` could give any role any permission, including the separate approval permissions that D-10 relies on.

Rule, implemented in `apps/api/src/authorization/access-policy.validator.ts` and `policy-evaluator.ts`:

- A policy may grant only permissions that exist in the permission catalog.
- It may never grant `tenant:manage`, `user:manage`, `data_source:manage`, `mapping:approve`, `semantic_model:manage` or `semantic_model:publish`. These come from a role assignment only, which is audited as `membership.roles_changed`.
- Data grants are made through `entities`, `measures` and `dimensions` (checked against the published model), not by writing `entity:x:read` as a permission.
- The evaluator applies the same rule to stored policies, so an older policy cannot grant them either.
- Row rules and column masks must name a column known for the entity. An unknown column is rejected, because a mask on a misspelt column would protect nothing.

Confirmed by the product owner on 2026-11-14, with `data_source:manage` and `semantic_model:manage` added to the restricted list because both let a role reshape what data the tenant exposes. The rest of this ADR (P-18 to P-20) stays Proposed.
