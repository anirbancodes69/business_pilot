# AI orchestration pipeline — detailed design

Summary: [AI_ENGINEERING.md](../../AI_ENGINEERING.md). Orchestrator, investigation, conversation state and provenance: [analyst-orchestrator.md](analyst-orchestrator.md). Decision: [ADR-0006](../adr/ADR-0006-ai-orchestration.md). Not implemented.

## Stage contracts

Each stage is a pure function over typed models (Pydantic), except for its declared side effects (LLM call, tool call). The pipeline runner records the input hash, output, latency and token usage of each stage in the AI execution record.

```python
# Illustrative only — not implemented
class Stage(Protocol[I, O]):
    name: str
    async def run(self, inp: I, ctx: PipelineContext) -> O: ...
```

`PipelineContext` holds the RequestContext token (opaque), the authorized semantic view, limits (`max_tool_calls`, `max_tokens`, deadline) and the tool client. It has no database handles.

## QueryPlan

Schema: [contracts/ai/query-plan.schema.json](../../contracts/ai/query-plan.schema.json). Key properties:

- `measures[]`: semantic measure IDs.
- `dimensions[]`: group-by dimension IDs, with optional time grain.
- `filters[]`: `{dimension, operator, values}`. Values are parameters, never SQL.
- `time_range`: either a relative token (`today`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `fiscal_ytd`, `last_fiscal_year`, `last_n_days` with `n`, …) or explicit absolute dates. The planner never does date arithmetic. A deterministic resolver in ai-engine (P-17) converts tokens to absolute dates using `resolved_now`, the tenant timezone and `fiscal_year_start_month`, before validation. The api re-checks that compiled ranges are absolute.
- `comparison`: optional `{type: previous_period | same_period_last_year | custom, time_range}`.
- `sort`, `limit` (capped by policy, default max 100).
- `breakdowns[]` (diagnostic only): dimensions to decompose a change by. Capped by `max_tool_calls`.

### Normalization (for caching)

Sort arrays of IDs, canonicalize filter value order, use the *resolved* absolute ISO dates (the exact cache keys on resolved dates; the semantic cache stores the relative form), apply default limits explicitly, and drop presentation-only fields. `normalized_plan_hash = SHA-256(canonical JSON)`.

## Plan compiler (in the api, not in ai-engine)

1. Validate against the schema and the **published** semantic model version given in the RequestContext.
2. Check every measure, dimension and filter against the AuthorizationContext. Any miss → reject (403).
3. Resolve the join path from the semantic model's relationship graph (only declared joins).
4. Add mandatory predicates: `tenant_id`, `deleted_at IS NULL`, the measure's definition filters, and ABAC row filters.
5. Emit parameterized SQL. Apply column masks to output.
6. Run with `SET LOCAL TRANSACTION READ ONLY`, `SET LOCAL statement_timeout`, and a `LIMIT` of plan limit + 1 to detect truncation.

## Diagnostic ("why") questions

1. Plan: the main measure over current and comparison periods, plus `breakdowns` (for example `branch`, `product.category`, `customer`).
2. Execute the totals and each breakdown (one tool call each, within `max_tool_calls`).
3. In code: compute the total delta and each member's contribution to the delta, then rank by absolute contribution.
4. The LLM explains the top contributors and labels causes as *possible explanations*. Causes that are not in the data (for example "seasonality") must appear under `possible_explanations`, never under `verified_facts`.

This is the accepted baseline. Drilling adaptively into a discovered contributor (step catalog, budget, stop rules) is proposed in [analyst-orchestrator.md §3.3](analyst-orchestrator.md#33-multi-step-investigation-adr-0010) and is OPEN ([ADR-0010](../adr/ADR-0010-bounded-adaptive-investigation.md)).

## Grounding check

Extract numeric tokens from the narrative fields (handling Indian digit grouping, lakh/crore words, percentages and currency symbols). Each must match a verified value or derived value within the declared rounding. Mismatches → one regeneration with the mismatch list. If it still fails → facts-only answer. Record the outcome.

## Limits (defaults, configurable per tenant)

`max_tool_calls` = 6, planner repair attempts = 1, explanation regeneration = 1, request deadline = 30 s, result rows sent to the LLM ≤ 50 per result set (top-N plus totals).
