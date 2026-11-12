# ADR-0010: Bounded adaptive investigation (AI Analyst Orchestrator)

- **Status:** OPEN (awaiting product-owner decision). Refines, and does not replace, D-07 ([ADR-0006](ADR-0006-ai-orchestration.md)).
- **Date:** 2026-11-13
- **Decision items:** D-OPEN-19

## Context

The product direction (2026-11-13, [PRODUCT.md](../../PRODUCT.md)) makes BusinessPilot an AI Business Analyst that carries out **multi-step investigation**: it finds where a change comes from and drills into what it finds. ADR-0006 §4 currently says diagnostic questions declare their breakdowns up front, and that the engine "never decides to keep exploring". With that rule the system cannot drill into a contributor it discovered, such as a branch, and then decompose that branch by category. Analysts do this routinely.

D-07 (Accepted) forbids *uncontrolled* agent loops and free-form tool selection, because they make cost, behaviour and evaluation unpredictable. Any adaptive investigation must keep those properties.

Design: [docs/ai/analyst-orchestrator.md §3.3](../ai/analyst-orchestrator.md#33-multi-step-investigation-adr-0010).

## Decision (proposed options)

The orchestrator is a deterministic state machine. Investigation steps come from a **closed, code-defined step catalog**. Every step compiles to `QueryPlan`s that the api re-authorizes. There is a hard budget (`max_tool_calls` default 6, `max_depth` 2, a 30 s deadline) and deterministic stop rules (coverage of the change explained, minimum contribution share, budget, data quality). The open question is **who picks the next step**:

| Option | Next step chosen by | Notes |
|---|---|---|
| A | Deterministic rules (e.g. drill into the largest contributor when its share is ≥ the threshold, following the dimension hierarchy) | Fully reproducible; golden tests can assert the exact path |
| B | The LLM picks one item from the catalog; code validates it against the budget, the authorized view and the stop rules | More flexible; the path can vary between runs |
| C | No adaptation: all breakdowns are declared up front (the current ADR-0006 §4 behaviour) | Simplest; cannot drill |

**Recommendation:** A for the MVP (Milestone 6). Consider B only if evaluation shows a measurable gain in investigation success at equal grounding and isolation results.

## Alternatives considered

- **Free-form agent loop with tool selection.** Rejected by D-07.
- **Precomputed insight cubes, with no query-time investigation.** Cheap at answer time, but costly to maintain per tenant, stale between syncs and limited to anticipated questions.

## Advantages

- Delivers the analyst behaviour while staying within D-07.
- Every step goes through the same authorization, compiler and cache path, so it adds no new trust boundary.

## Disadvantages

- More orchestration code and more evaluation cases.
- Depth and coverage thresholds are hypotheses that need tuning on pilot-shaped data.

## Security implications

- Drill filter values come from previously authorized results and are passed as parameters. The api re-authorizes every step and injects ABAC filters, so a step cannot widen scope.
- A rejected step ends that branch and is reported as an unknown. It is never retried with a different scope.

## Consequences

- ADR-0006 §4 must be amended to reference this ADR if A or B is accepted.
- `QueryPlan` itself does not need to change. Steps compile to existing plan features. A `step_kind` field may be added for audit, which would need a contract version bump.
- New evaluation category: investigation success ([docs/ai/evaluation.md](../ai/evaluation.md)).

## Revisit conditions

- Investigation success on the golden set stays below the target with option A.
- p95 latency exceeds the deadline because of step count.
