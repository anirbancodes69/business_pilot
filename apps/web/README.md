# apps/web — Next.js frontend

**Status: first screen (2026-11-15; see [CURRENT.md](../../CURRENT.md)).** Implemented: sign-in (authorization code with PKCE, sealed `HttpOnly` session cookie, [ADR-0020](../../docs/adr/ADR-0020-web-sign-in-and-session.md), proposed), sign-out, and the chat page (`/`) that asks questions and shows answers. UI rules: [docs/ui/ui-standards.md](../../docs/ui/ui-standards.md) (proposed). Not implemented: everything else listed below.

Responsibilities: sign-in, active-tenant selection, chat UI that renders AnswerResponse sections (facts, calculations, explanations, recommendations, unknowns, sources, freshness), data-source onboarding, mapping review and approval, semantic model publishing, user and role admin, sync status.

Rules: no business logic or authorization decisions in the frontend. It calls only the public api, using the OpenAPI client from `packages/api-contracts`. It never talks to ai-engine directly.
