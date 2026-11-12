# ADR-0012: Numerical provenance and evidence model

- **Status:** OPEN (awaiting product-owner decision)
- **Date:** 2026-11-13
- **Decision items:** D-OPEN-21

## Context

CLAUDE.md rule 4 and D-07 require numbers to come from queries, with derived values computed in code. The current safeguard is a post-hoc grounding check: numeric tokens in the narrative are matched against results and derived values within rounding ([orchestration-pipeline.md](../ai/orchestration-pipeline.md#grounding-check)). Matching by value can pass a number that is right by coincidence but cites the wrong source. It also struggles with lakh and crore phrasing and rounding. Multi-step investigation produces many more numbers per answer.

Design: [docs/ai/analyst-orchestrator.md §6](../ai/analyst-orchestrator.md#6-numerical-provenance-and-evidence-adr-0012).

## Decision (proposed)

Every number shown to a user has exactly one provenance record in a per-request **evidence ledger**:

- `result`: a cell in an api result set, with the plan hash, semantic model version, data version, execution time and sources.
- `derived`: a code-registry formula with input evidence IDs.
- `config`: a value from a tenant configuration document, such as a business rule threshold.

The open question is how the narrative refers to numbers:

| Option | Description |
|---|---|
| A | The LLM writes evidence placeholders (e.g. `{{ev_3f2a}}`). Code renders the values in the tenant's number format. The grounding check rejects any literal digits that are not part of an allowed context such as a date or name (recommended) |
| B | The LLM writes numbers. Code matches each one to the ledger (current design, extended with evidence IDs on facts) |

**Recommendation:** A, keeping the grounding check as a second defence.

## Alternatives considered

- **No narrative numbers; tables only.** Safe, but loses the analyst experience.

## Advantages

- Provenance is exact rather than inferred. The UI can show "where does this number come from" for every value.
- Number formatting (Indian grouping, lakh and crore) is done in one place, in code.

## Disadvantages

- Prompt and output-schema complexity. Placeholder misuse has to be validated.
- `AnswerResponse` needs evidence fields (contract version bump).

## Security implications

- The ledger is stored under the tenant's retention policy (D-OPEN-12), with the AI execution record. It holds only values already shown to the authorized user.
- No ledger content goes to logs or traces.

## Consequences

- Bump `answer-response` (adds `evidence[]`, and evidence IDs on facts, calculations, explanations and recommendations).
- New evaluation metric: provenance coverage, 100% hard gate.

## Revisit conditions

- Option A measurably hurts explanation quality in evaluation.
