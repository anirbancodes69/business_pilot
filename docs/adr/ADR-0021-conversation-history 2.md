# ADR-0021: Conversation history

- **Status:** Proposed (2026-11-15). The product owner asked for the behaviour (conversations must survive a new conversation and a reload); the retention number and the storage of answers await confirmation.
- **Date:** 2026-11-15. Revises the "no question text or answer is stored" part of [ADR-0011](ADR-0011-analytical-conversation-state.md).

## Context

[ADR-0011](ADR-0011-analytical-conversation-state.md) stored only a typed context per turn, to avoid a long-lived copy of tenant data. Users need to come back to earlier conversations, so the question and the answer as shown must be kept.

## Decision (proposed)

- A turn keeps its **question** and its **answer** (the response the user saw, with the validated context). Private to the user: every read filters by the user, another user or tenant gets a plain 404, and row-level security keeps tenants apart.
- **Retention:** 90 days after the last turn (`CONVERSATION_RETENTION_DAYS`, 1 to 3650). Expired conversations are removed when their user is next active (not by a scheduled job yet).
- The user can **delete** a conversation. Usage metering (`core.ai_execution`) is kept (counts only) and no longer has a foreign key to the turn.
- An answer larger than 800,000 characters is not kept; the conversation still is.
- **Audit events and logs still never carry question or answer text.**
- API: `GET /v1/conversations` (the user's list, newest first, titled by the first question), `GET /v1/conversations/:id`, `DELETE /v1/conversations/:id`.

## Consequences

- The sidebar lists the user's conversations; opening one shows the stored answers and "Answered <day>". Old answers show what was true then, not today.
- Conversations are tenant business data at rest: covered by tenant deletion (crypto-shredding is not built), backups, and the retention in [data-handling.md](../security/data-handling.md).
- Not done: a scheduled purge, per-tenant retention, export, search, sharing.
