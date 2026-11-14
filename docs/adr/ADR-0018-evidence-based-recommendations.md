# ADR-0018: How recommendations are generated

- **Status:** Accepted 2026-11-14 as D-23 (the product owner approved the recommendation)
- **Date:** 2026-11-14
- **Decision items:** D-OPEN-23

## Context

Recommendations are a core capability of the AI Business Analyst ([PRODUCT.md](../../PRODUCT.md), [analyst-orchestrator.md §3.5](../ai/analyst-orchestrator.md#35-evidence-based-recommendations-d-open-23)). Rule 4 of CLAUDE.md says the model must not invent figures. A recommendation must therefore rest on findings that came from queries, and it must never trigger an action in a customer system.

## Decision (proposed)

A hybrid. Code decides **whether** a recommendation exists, and the LLM only helps with **how it is worded**.

1. Each tenant template ships a small set of playbooks (for the wholesale template, for example "a few customers hold most of the overdue dues"). A playbook has a trigger written as a rule over findings and thresholds from the tenant's configuration.
2. When a trigger fires on the evidence ledger, the orchestrator creates a recommendation shell that already lists the findings it rests on.
3. The LLM may reword the shell in plain business language. Every number in the wording is an evidence placeholder (ADR-0012), never a literal.
4. A recommendation with no finding attached is dropped. The grounding check applies to it like any other text.

## Alternatives considered

- **Templates only.** Safest, but the wording is stiff and every case needs hand-written text.
- **LLM free to suggest anything over the findings.** Flexible, but it can suggest things the data does not support, and it is hard to evaluate.

## Advantages

- Reproducible: the same findings give the same recommendations, so golden tests can assert them.
- The model cannot invent a reason to act.

## Disadvantages

- Coverage is limited to the playbooks we write. New cases need a code or configuration change.
- Thresholds are unvalidated hypotheses until pilot data exists.

## Security implications

- Playbook triggers read only the authorized evidence ledger, so a recommendation cannot reveal data the user may not see.
- Recommendations are text only. No playbook calls a customer system.

## Consequences

- Playbooks live in the template and are versioned with the semantic model.
- New evaluation metric: every recommendation cites at least one finding (hard gate).

## Implementation note (2026-11-15)

Built in `apps/ai-engine/src/ai_engine/recommendations/playbooks.py`. In this first version the wording is **written by code from templates**, not by the model: it is cheaper, cannot invent a number, and is deterministic for tests. Model wording over the same findings stays possible later (it would need the same placeholder discipline). Four playbooks: a material decline (or a wrong-direction rise) in a plain figure suggests asking why; money owed concentrated in the top three customers suggests prioritising follow-up (it fetches the overall total with one extra data call when the ranking was cut short); a dominant part of an investigated change suggests reviewing it first; and a dominant sub-part suggests what to check inside it. Thresholds (10% change, 50% share, top three) are constants in code, **not yet the tenant's business rules**. At most two recommendations per answer; a recommendation with no evidence id is dropped by `recommend`, and tests check that every number in a recommendation's text appears in the evidence it cites.

## Revisit conditions

- Pilot users ask for recommendations the playbooks cannot produce.
