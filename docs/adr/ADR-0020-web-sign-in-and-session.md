# ADR-0020: Web sign-in and session

- **Status:** Proposed (2026-11-15). Part of D-OPEN-03 (web sessions); the identity provider for hosted environments is still open.
- **Date:** 2026-11-15

## Context

The web app has no sign-in. [SECURITY.md §6a](../../SECURITY.md) asks for `HttpOnly`, `Secure`, `SameSite` cookies or short-lived bearer tokens, CSRF protection, restricted CORS and security headers. The local Keycloak client already allows the authorization-code flow with redirects to `http://localhost:3000/*`. The password grant exists only until a login screen does.

## Decision (proposed)

- Sign-in uses the **authorization-code flow with PKCE**. Next.js server route handlers start it (`/login`), finish it (`/callback`) and end it (`/logout`).
- **Tokens stay on the server.** They are sealed (AES-256-GCM, key from `WEB_SESSION_SECRET`) into one `HttpOnly`, `SameSite=Lax` cookie. Browser JavaScript never sees an access or refresh token. No new datastore: the cookie carries the session.
- The browser calls only same-origin routes of the web app (`/api/...`). Those routes unseal the cookie, refresh the access token when it is close to expiry, and call the api with `Authorization: Bearer` and `X-Tenant-Id`.
- The active tenant is chosen from `GET /v1/me` (the only memberships the user has) and kept in the sealed session. The api still verifies membership on every call.
- POSTs check the `Origin` header against the web origin (on top of `SameSite`).

## Alternatives considered

- Access token in browser storage: simpler, but any script injection steals it. Rejected.
- Server-side session in Redis: revocable, but adds state and a failure mode. Worth revisiting when logout-everywhere or admin revocation is needed.

## Disadvantages and risks

- A cookie-held session cannot be revoked server-side before it expires; refresh tokens are the limit. Keep the cookie lifetime to the refresh token's.
- Cookie size limits (about 4 KB): the sealed session must stay small (tokens and ids only).
- `WEB_SESSION_SECRET` rotation logs everyone out (acceptable for now).

## Security implications

- No token in the browser; CSRF is covered by `SameSite` plus the origin check; the api remains the only authority on tenant and permissions.
- The secret is required and fails closed: without it, sign-in is refused.

## Consequences

- New required variable `WEB_SESSION_SECRET` (and `WEB_BASE_URL`, `OIDC_*` for the web service).
- The password grant in the local realm can be disabled once this works.
