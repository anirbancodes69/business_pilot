# apps/web — Next.js frontend

**Status: skeleton** (Milestone 1; see [CURRENT.md](../../CURRENT.md)). Implemented: App Router shell and `GET /api/health`. Nothing else.

Responsibilities: sign-in, active-tenant selection, chat UI that renders AnswerResponse sections (facts, calculations, explanations, recommendations, unknowns, sources, freshness), data-source onboarding, mapping review and approval, semantic model publishing, user and role admin, sync status.

Rules: no business logic or authorization decisions in the frontend. It calls only the public api, using the OpenAPI client from `packages/api-contracts`. It never talks to ai-engine directly.
