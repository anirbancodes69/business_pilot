# ADR-0011: Structured analytical conversation state

- **Status:** OPEN (awaiting product-owner decision)
- **Date:** 2026-11-13
- **Decision items:** D-OPEN-20

## Context

Analysts work in follow-ups: "Why?", "What about Nashik?", "Same for last quarter", "Break that down by customer". Today the conversation state is a free-text `conversation_summary` of up to 2000 characters ([contracts/ai/answer-response.schema.json](../../contracts/ai/answer-response.schema.json) v0.1.0), written by the LLM and sent back on the next turn. Free text cannot be validated, cannot be re-checked against changed permissions, and makes follow-up resolution depend on the model's reading of prose.

Design: [docs/ai/analyst-orchestrator.md §5](../ai/analyst-orchestrator.md#5-structured-analytical-conversation-state-adr-0011).

## Decision (proposed)

Replace `conversation_summary` with a typed `AnalyticalContext`: the current focus (metrics, dimensions, filters, relative time range, comparison), the last analysis type, open hypotheses and evidence references. It contains no result rows, no figures and no question text. Follow-ups are classified into typed deltas and applied to the context in code. The api stores the context per turn in a tenant-scoped table with RLS forced, and **re-validates it against the user's current authorized view on every turn** before sending it to ai-engine.

Options:

| Option | Description |
|---|---|
| A | Structured `AnalyticalContext` only (recommended) |
| B | Structured context plus a short free-text summary, for the LLM's benefit only and never trusted for scope |
| C | Keep the free-text summary (current contract) |

**Recommendation:** A, with B only if evaluation shows that follow-up resolution needs it.

## Alternatives considered

- **Send the full turn history to the LLM.** Costly, grows without bound, and puts earlier result figures into prompts (D-OPEN-14).

## Advantages

- Follow-ups become testable: the expected delta can be asserted exactly.
- State can be re-authorized every turn and migrated across semantic model versions.

## Disadvantages

- A contract change (`answer-response`, and the answer request) and a new control-plane table.
- Follow-ups that fall outside the typed deltas must be clarified rather than guessed.

## Security implications

- Context is never a source of authority. Filters inside it are re-checked like user input, and items the user lost access to are removed.
- No figures or rows are stored in the context, which limits exposure under retention policies.
- Needs a tenant isolation test: one user's context cannot be loaded by another user or tenant (add to [tenant-isolation-tests.md](../security/tenant-isolation-tests.md) when implemented).

## Consequences

- Bump `answer-response` to 0.2.0 and update [contracts/ai/README.md](../../contracts/ai/README.md) in the same change that implements it.
- Golden set gains multi-turn cases.

## Revisit conditions

- More than about 15% of real follow-ups fall outside the typed deltas.
