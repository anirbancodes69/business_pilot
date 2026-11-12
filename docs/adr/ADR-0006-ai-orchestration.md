# ADR-0006: AI orchestration

- **Status:** Accepted (D-04, D-07). Proposed (P-02, P-03, P-13). OPEN (D-OPEN-01, D-OPEN-14).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-07 Deterministic orchestration; no uncontrolled loops; figures grounded in query results | Accepted |
| D-04 The LLM never decides permissions | Accepted |
| P-02 The AI engine reaches data only through API tool endpoints | Proposed |
| P-03 The LLM emits a `QueryPlan`, which the API compiles to SQL; no raw SQL | Proposed |
| P-13 Immutable, versioned semantic models | Proposed |
| P-16 ai-engine computes all embeddings; api and worker store and search only | Proposed |
| P-17 Relative time tokens resolved deterministically; no LLM date arithmetic | Proposed |
| D-OPEN-15 Service authentication and RequestContext signing | OPEN |
| D-OPEN-01 LLM provider | OPEN |
| D-OPEN-14 What result data the LLM may see | OPEN |

## Context

Business users will act on the numbers BusinessPilot gives them. LLMs are good at understanding questions and writing explanations. They are unreliable at arithmetic and at writing correct SQL against unfamiliar schemas, and they are open to prompt injection. Agent frameworks with free-form tool loops make cost, latency and behaviour unpredictable and hard to evaluate.

## Decision

1. A **fixed pipeline** of stages ([AI_ENGINEERING.md §2](../../AI_ENGINEERING.md#2-pipeline)), each with typed input and output. LLM stages produce schema-constrained JSON, validated before use, with at most one repair attempt.
2. **Query plan as the intermediate representation** (P-03): the planner outputs a `QueryPlan` ([query-plan.schema.json](../../contracts/ai/query-plan.schema.json)) that references semantic IDs (measures, dimensions, filters, time ranges, sort, limit). The API's compiler turns it into parameterized SQL against canonical tables. The plan's parameter slots carry the values; the model never produces SQL text.
3. **Trust boundary** (P-02): ai-engine is a trusted internal service, but holds no data-store credentials. It calls API tools (`execute-plan`, `retrieve-context`, `semantic-cache-lookup`, `semantic-cache-store`) with a short-lived, API-signed RequestContext. The API re-authorizes on every call.
4. **Bounded diagnostics:** "why" questions use a plan with a declared list of breakdowns. The engine runs at most `max_tool_calls` executions (default 6) and never decides to keep exploring. *(2026-11-13: a bounded adaptive refinement is proposed in [ADR-0010](ADR-0010-bounded-adaptive-investigation.md), which is OPEN. This item stays in force until ADR-0010 is decided.)*
5. **Grounding:** derived values are computed in code. Narrative numbers are checked against results and derivations.
6. **Semantic layer:** versioned and immutable once published (P-13). The planner sees only the user's authorized view.
7. **Model access:** ai-engine is the only component that calls LLM or embedding providers (P-16). For indexing, the worker sends approved text to ai-engine's internal embeddings endpoint and stores the returned vectors itself. At query time, ai-engine sends vectors, not text, to the retrieval tools.
8. **Dates:** the planner outputs relative time tokens or absolute dates. Code resolves them (P-17).

## Alternatives considered

- **Text-to-SQL directly by the LLM.** Flexible, but it creates injection and exfiltration risk, is hard to validate, and ties accuracy to schema quality. It may be offered later as an admin-only exploration mode behind its own ADR.
- **Autonomous or multi-agent frameworks.** Unpredictable cost and behaviour, and hard to test.
- **AI engine with direct read-only database access.** Lower latency, but it puts a second trust zone on tenant data and duplicates authorization logic.
- **Orchestration in the NestJS API, with ai-engine as stateless prompt endpoints.** Viable. Rejected because AI tooling, evaluation and prompt management fit better in Python, and the tool callback keeps security in the API anyway.

## Advantages

- Testable, reproducible behaviour. Plans can be compared exactly in evaluation.
- Authorization and SQL safety live in one trusted place.
- Plans are cacheable and auditable.

## Disadvantages

- The expressiveness of plans limits which questions can be answered. Unsupported questions must be refused or clarified honestly.
- Extra network round trips between ai-engine and api (tool calls).
- The plan schema and compiler are significant engineering work.

## Security implications

- Prompt injection cannot widen scope, because scope never comes from the model.
- The RequestContext must be signed, short-lived (for example 2 minutes) and bound to `request_id`.
- The data sent to the LLM is limited by D-OPEN-14.

## Consequences

- The plan schema is a core contract. Changing it means updating the compiler, evaluation set and cache normalization together.
- The evaluation suite is required before the AI pipeline can be released.

## Revisit conditions

- More than about 15% of real pilot questions are unanswerable because of plan expressiveness. Then extend the plan schema, or evaluate a guarded SQL mode through a new ADR.
- Tool-call latency dominates p95 answer time. Then consider co-locating or batching.
