# AI_ENGINEERING.md — AI orchestration, semantic layer and caching

Nothing here is implemented yet. Details: [docs/ai/orchestration-pipeline.md](docs/ai/orchestration-pipeline.md), [docs/ai/caching.md](docs/ai/caching.md), [docs/ai/evaluation.md](docs/ai/evaluation.md). Contracts: [contracts/ai/](contracts/ai/), [contracts/semantic-model/](contracts/semantic-model/).

## 1. Design stance

- **Deterministic orchestration** (D-07). The pipeline is a fixed sequence of stages written in code. The LLM is used only inside specific stages, and its output there is constrained by a schema and validated.
- **No uncontrolled agent loops.** There is no agent-to-agent delegation and no free-form tool selection. Diagnostic questions use bounded plans that declare their breakdowns up front.
- **The LLM proposes. Trusted code decides.** Permissions, tenant scope, SQL generation and arithmetic all happen outside the model (D-04, P-02, P-03).
- **ai-engine owns all model access** (LLM and embeddings, P-16). The api and worker store and search vectors but never call model providers.
- **Use specialized models only when they earn it.** Start with one capable model for every LLM stage, and introduce a smaller model per stage only when evaluation shows it holds quality and lowers cost or latency.

## 2. Pipeline

| # | Stage | LLM? | Output |
|---|---|---|---|
| 1 | Input guard: length, language, obvious injection markers, quota | No | Accept or reject |
| 2 | Intent classification | Yes (small, schema-constrained) | `metric`, `ranking`, `comparison`, `trend`, `diagnostic`, `knowledge`, `recommendation`, `clarify`, `out_of_scope` |
| 3 | Semantic context retrieval: relevant entities, measures and glossary terms from the user's authorized view. In Milestone 6 this uses lexical and synonym matching only. From Milestone 7, vector search is added: ai-engine embeds the question (P-16) and calls the `retrieve-context` tool | No (embedding only) | Context bundle |
| 4 | Semantic cache lookup ([§5](#5-caching)) | No | Candidate plan or miss |
| 5 | Query planning | Yes | `QueryPlan` JSON ([contracts/ai/query-plan.schema.json](contracts/ai/query-plan.schema.json)) |
| 6 | Time resolution (P-17): relative tokens (`last_month`, `fiscal_ytd`, …) become absolute dates from `resolved_now`, the tenant timezone and the fiscal year. Then plan validation: schema, references to the authorized view, limits | No | Valid plan, or one repair attempt with the errors fed back, then `clarify` |
| 7 | Execution through the API tool `execute-plan`. The API re-authorizes, injects ABAC filters, checks the exact cache, compiles SQL and runs it | No | Result sets + sources + freshness |
| 8 | Derived calculations: deltas, percentages, shares, contributions to change | No (code) | Derived values with formulas |
| 9 | Explanation generation | Yes | Draft `AnswerResponse` |
| 10 | Grounding check: every number in the narrative matches a result or derived value within rounding | No | Pass, one regeneration, or degrade to a facts-only answer |
| 11 | Persist and respond, with an AI execution record | No | `AnswerResponse` ([contracts/ai/answer-response.schema.json](contracts/ai/answer-response.schema.json)) |

`knowledge` intents (for example "what is our credit policy?") skip stages 5–8 and answer from retrieved approved documents with citations. `recommendation` intents ("what should management investigate this week?") run a predefined, tenant-configurable set of checks, such as metrics that moved beyond a threshold, overdue receivables and margin decline, through the same plan and execute path.

## 3. Semantic layer

The semantic model is the tenant's versioned business vocabulary ([contracts/semantic-model/](contracts/semantic-model/), [schemas/semantic-model/semantic-model.schema.json](schemas/semantic-model/semantic-model.schema.json)):

- **Entities** map to canonical tables. **Relationships** define the allowed join paths.
- **Measures** carry an exact definition, for example `revenue = SUM(invoice_line.net_amount) WHERE invoice.status <> 'cancelled'`, plus unit, currency and default time dimension.
- **Dimensions** (branch, product category, customer segment, time grains) and **synonyms or glossary** entries in the tenant's own terms, including Indian business usage such as "outstanding", "dues" and "collections".
- **Versions** are immutable once published (P-13). Every plan, cache entry and answer records the `semantic_model_version` it used.

The planner never sees physical table names. It references semantic IDs only. The API's plan compiler is the only component that knows the physical mapping.

## 4. Answer structure

Every answer has typed sections: `verified_facts`, `derived_calculations` (each with its formula and inputs), `possible_explanations` (labelled hypotheses), `recommendations`, `unknowns`, `sources` (data source, entity, sync time) and `freshness`. The UI renders them distinctly. A section with no content is omitted, never padded.

## 5. Caching

Three separate mechanisms ([docs/ai/caching.md](docs/ai/caching.md), [ADR-0007](docs/adr/ADR-0007-caching-strategy.md)):

1. **Provider prompt caching.** Prompts are ordered from most stable to least stable: system instructions → output schema → (per tenant) semantic model summary for that version → conversation → question. This lets a provider that supports prefix caching reuse the stable prefix. It saves cost and latency only; it never affects correctness. Provider-specific limits must be checked when D-OPEN-01 is decided.
2. **Exact application cache.** Validated query results are stored under a key built from `tenant_id`, `authz_scope_hash`, `normalized_plan_hash`, `semantic_model_version`, `data_version` (of each dataset the plan reads) and `cache_policy_version`. A sync that changes a dataset bumps its data version, so stale entries are never matched again.
3. **Semantic cache** (Milestone 8). Time expressions are first extracted deterministically and replaced with a placeholder ("revenue {TIME}"). An embedding of that normalized question then finds previously validated plans **for the same tenant and authorization scope**. A hit also requires the same intent and the same extracted time token. It returns a **candidate plan only**, with relative time tokens. That plan is re-resolved, re-validated and executed through the exact cache. Embedding similarity never returns a financial result directly (D-08, P-07).

Excluded from caching: live/federated results (unless a short TTL is configured), plans touching columns tagged PII or sensitive, and answers degraded by grounding failure.

## 6. Prompts

- Prompts live in `apps/ai-engine` as versioned files. Every AI execution record stores the prompt version.
- Tenant data inside prompts is clearly delimited and labelled as data, not instructions.
- Prompt changes go through the evaluation suite before merge ([docs/ai/evaluation.md](docs/ai/evaluation.md)).

## 7. Evaluation

A golden question set per industry template, run against a synthetic tenant dataset. Metrics: intent accuracy, plan exact-match and execution accuracy (results equal the expected results), numerical correctness, grounding pass rate, correct refusal of unauthorized requests, latency and cost. The suite runs in CI for prompt, model and planner changes. Details: [docs/ai/evaluation.md](docs/ai/evaluation.md).

## Observability

Each AI execution record and trace carries: `request_id`, `tenant_id`, intent, prompt versions, model IDs, tokens in and out (with cached tokens where the provider reports them), cost estimate, per-stage latency, cache results (prompt, exact, semantic), plan validation result, tool call count, grounding result and user feedback. Question and answer text are stored only under the tenant's retention policy and never in logs or traces.
