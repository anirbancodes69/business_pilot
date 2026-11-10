# Tenant contracts (draft v0)

| Schema | Produced by | Consumed by | Purpose |
|---|---|---|---|
| [authorization-context.schema.json](authorization-context.schema.json) | api `authorization` module | api `data-access` (plan compiler, caches), audit | The effective permissions of one user in one tenant for one request. **Never sent to ai-engine.** ai-engine receives only the derived *authorized semantic view* |
| [request-context.schema.json](request-context.schema.json) | api | ai-engine (opaque), api tool endpoints (verify) | Signed, short-lived token that binds AI tool calls to an authenticated request |

Rules (see [SECURITY.md](../../SECURITY.md)):

- `tenant_id` in either object comes only from the authenticated session and membership.
- When verifying a RequestContext, the api reloads the AuthorizationContext from its own state. It never trusts permission data inside the token.
- `authz_scope_hash` is defined in [docs/architecture/tenant-model.md](../../docs/architecture/tenant-model.md#effective-authorization).
