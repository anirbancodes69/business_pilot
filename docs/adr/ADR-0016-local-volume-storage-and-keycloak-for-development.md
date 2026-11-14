# ADR-0016: Local volume object storage and Keycloak for local development

- **Status:** Accepted (product owner, 2026-11-14). The hosted choices stay OPEN.
- **Date:** 2026-11-14
- **Decision items:** D-17 and D-18 (new, Accepted). D-OPEN-24 (object storage product) and D-OPEN-03b (identity provider vendor) remain OPEN for hosted deployments. D-15 still covers the dummy LLM provider.

## Context

Two things blocked further work after Milestone 4:

- **Storage.** The only object storage adapter kept uploads in process memory (ADR-0015). The sync worker (Milestone 5) is a separate process and could not read a file the api stored, and a restart lost every upload.
- **Sign-in.** The api verifies OIDC access tokens (P-18) but no identity provider existed, so nobody could sign in outside tests, and real key fetching had never been exercised.

Neither needs a production vendor yet. Everything runs on one machine with Docker Compose.

## Decision

1. **D-17: object storage on a shared Docker volume, for now.** A second adapter, `LocalObjectStorage` (`OBJECT_STORAGE_DRIVER=local`), writes objects under `OBJECT_STORAGE_LOCAL_DIR`. In Compose that directory is the named volume `objectdata`, mounted into both the api and the worker. The `ObjectStorage` port and its key rules are unchanged, so every object still lives under `tenants/{tenant_id}/`. The S3-compatible product for hosted deployments is still OPEN (D-OPEN-24) and must be decided before the first deployment that runs on more than one machine and before any pilot.
2. **D-18: Keycloak is the identity provider for local development.** Compose runs Keycloak in development mode with a realm file (`infrastructure/keycloak/businesspilot-realm.json`) that creates the realm `businesspilot` and one public client `businesspilot`. The realm file holds no users and no secrets. The production identity provider is still OPEN (D-OPEN-03b): self-hosted Keycloak and a managed vendor both remain possible, because the api relies only on standard OIDC.
3. **`OIDC_JWKS_URL` (optional).** Tokens name the browser-facing URL as issuer (`http://localhost:8080/realms/businesspilot`), which the api container cannot reach. When this variable is set, the api fetches signing keys from it and skips discovery. Issuer, audience, signature and expiry are verified exactly as before.

## Alternatives considered

- **An S3-compatible server in Compose (MinIO, SeaweedFS, Garage).** Closer to production, but adds a service, a client library and credentials for no benefit while everything runs on one machine. The MinIO image in Compose is a frozen mirror and is still unused.
- **A managed identity provider (Auth0, Clerk, Cognito).** Fast to start, but needs an account, puts user accounts with a third party before hosting is chosen, and cannot run offline or in CI.
- **Staying on the dummy storage adapter and a fake verifier.** Blocks Milestone 5 and any demonstration.

## Advantages

- The worker can read what the api stored, and uploads survive restarts. Milestone 5 is no longer blocked on a product choice.
- Real sign-in works locally and the real token path (key fetching, issuer and audience checks) is exercised.
- Both are swappable: storage through the port, the identity provider through three environment variables.

## Disadvantages

- The volume works on one machine only. It has no replication, versioning or lifecycle rules, and backups are whatever the host does.
- Keycloak adds a container (about 500 MB of memory) and startup time to the local stack and the CI smoke test.
- The realm file enables the password grant so the api can be called before a login screen exists. It is a development convenience and must not be carried into a production realm.

## Security implications

- **Tenant isolation.** Paths are built only from `tenantObjectKey`, which validates the tenant id and every key segment. The adapter also checks that the resolved path stays inside its root. Tests cover two tenants with the same key and keys that try to leave the tenant directory. Isolation rests on application code: anyone with access to the volume can read every tenant's files.
- **No encryption at rest** beyond what the host disk provides. Files are created with mode 0600 in directories with mode 0700, owned by the non-root `node` user. The S3 adapter must use provider-side encryption.
- **Keycloak development mode** uses plain HTTP and an embedded database. Its port is bound to 127.0.0.1. The admin password comes from `.env` and is never committed. Brute-force protection is on and self-registration is off. MFA (SECURITY.md) is not configured in the local realm.
- `OIDC_JWKS_URL` moves trust in the signing keys to whatever that URL serves. It must point only at the identity provider, over a trusted network (the Compose network locally) or HTTPS.

## Operational implications

- New named volumes: `objectdata` and `keycloakdata`. `docker compose down -v` deletes uploads and Keycloak users.
- New variables: `OBJECT_STORAGE_LOCAL_DIR`, `OIDC_JWKS_URL`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_PORT` (optional). An existing `.env` needs `KEYCLOAK_ADMIN_PASSWORD` added before the stack starts.
- Users are created in the Keycloak admin console. A signed-in user has no tenant until an operator provisions one (`pnpm tenant:provision`, added after this decision). There is no HTTP route for it.

## Revisit when

- A deployment runs on more than one machine, or a pilot tenant is planned (decide D-OPEN-24 and D-OPEN-03b).
- The web app gets a login screen (turn the password grant off in the realm file).
