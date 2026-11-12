# AI Analyst Orchestrator — design

**Status: design, not implemented.** Parts of this document depend on decisions that are still OPEN. They are marked **[ADR-0010]**, **[ADR-0011]**, **[ADR-0012]** and **[D-OPEN-23]**. Until those are decided, the accepted baseline is the one in [ADR-0006](../adr/ADR-0006-ai-orchestration.md): a fixed pipeline, with diagnostic breakdowns declared up front.

Summary: [AI_ENGINEERING.md](../../AI_ENGINEERING.md). Product view: [PRODUCT.md](../../PRODUCT.md#core-ai-capabilities). Pipeline and compiler details: [orchestration-pipeline.md](orchestration-pipeline.md). Semantic model: [semantic-business-model.md](semantic-business-model.md).

## 1. What the orchestrator is

The AI Analyst Orchestrator is the component in `apps/ai-engine` that turns a business question into an answer backed by evidence. It is a **deterministic state machine written in code**. It is not an autonomous agent. The LLM is called only inside specific states, its output there is constrained by a schema and validated, and every transition is decided by code.

It never touches data directly. Each data access is a `QueryPlan` sent to the api's `execute-plan` tool. The api authorizes the plan again, compiles it to parameterized SQL and runs it (P-02, P-03). The orchestrator only reasons over results the api has already authorized and returned.

## 2. Responsibilities split

| Concern | Owner | LLM involved? |
|---|---|---|
| Authentication, tenant, AuthorizationContext, authorized semantic view | api | Never (D-04) |
| Understanding the question, choosing an analysis type | Orchestrator | Yes, schema-constrained |
| Writing `QueryPlan`s from semantic IDs | Orchestrator | Yes, schema-constrained, then validated |
| Choosing the next investigation step | Orchestrator | Rules first; LLM only from a closed step catalog **[ADR-0010]** |
| Plan validation, ABAC injection, SQL compilation, execution, audit | api | Never |
| Arithmetic: deltas, shares, contributions, ratios, rankings | Orchestrator, in code | Never (CLAUDE.md rule 4) |
| Evidence ledger and provenance | Orchestrator, in code | Never **[ADR-0012]** |
| Narrative explanation, hypotheses, recommendation wording | Orchestrator | Yes, constrained to cite evidence |
| Grounding check | Orchestrator, in code | Never |
| Persisting conversation state | api (tenant-scoped, RLS) | Never **[ADR-0011]** |

## 3. The five capabilities as orchestrator states

```
 question + AnalyticalContext (from api)
   │
   ▼
 [1] UNDERSTAND ──▶ BusinessIntent  (or clarify / out_of_scope / not_authorized)
   │
   ▼
 [2] PLAN ────────▶ AnalysisPlan    (ordered steps, each compiling to ≥1 QueryPlan)
   │
   ▼
 [3] INVESTIGATE ─┐ execute step through api ─▶ compute findings in code
   │   ▲          │ ─▶ stop rule met?  no ─▶ select next step (bounded) ──┘
   │   └──────────┘
   ▼ yes / budget exhausted
 [4] DIAGNOSE ────▶ ranked contributing factors with evidence; hypotheses labelled
   │
   ▼
 [5] RECOMMEND ───▶ recommendations, each citing evidence  [D-OPEN-23]
   │
   ▼
 EXPLAIN + GROUND ─▶ AnswerResponse + updated AnalyticalContext
```

### 3.1 Business intent understanding

Input: question, the `AnalyticalContext` from earlier turns **[ADR-0011]**, and the authorized semantic view. Output: a typed `BusinessIntent`:

- `analysis_type`: `metric`, `ranking`, `comparison`, `trend`, `diagnostic`, `recommendation`, `knowledge`, `clarify`, `out_of_scope`. These are the intents already in [AI_ENGINEERING.md §2](../../AI_ENGINEERING.md#2-pipeline).
- `follow_up_type` when the turn depends on context: `refine_filter`, `change_time`, `change_metric`, `drill_down`, `ask_why`, `compare_to`, `new_topic`.
- Referenced semantic IDs (metrics, dimensions, members) and time expressions as relative tokens (P-17).

Business vocabulary ("dues", "collections", "slow movers") is resolved through glossary and synonym entries in the semantic model, not by the LLM's general knowledge. If a term cannot be resolved, the result is `clarify`. The orchestrator does not guess.

### 3.2 Analytical planning

The planner turns the intent into an `AnalysisPlan`: an ordered list of typed **steps** from a closed catalog (below). Each step compiles deterministically into one or more `QueryPlan`s. The plan also lists the hypotheses it can test, for example "the drop is concentrated in one branch", along with the step that tests each one.

### 3.3 Multi-step investigation **[ADR-0010]**

**Step catalog (closed; extended only by code and ADR):**

| Step kind | Purpose | Compiles to |
|---|---|---|
| `measure_snapshot` | Value of a metric for a scope and period | 1 QueryPlan |
| `period_comparison` | Current vs comparison period | 1 QueryPlan with `comparison` |
| `decompose_by_dimension` | Contribution of each member to a change | 1 QueryPlan per dimension |
| `drill_into_member` | Narrow to a top contributor, then decompose by the next dimension in its hierarchy or driver path | 1 QueryPlan, with a member filter taken from a previous result |
| `driver_decomposition` | Split a metric into its declared drivers (e.g. revenue = volume × price; mix and rate) using the semantic model's driver definitions **[ADR-0013]** | 1–3 QueryPlans |
| `trend_check` | Whether a change is recent or long-running | 1 QueryPlan with a time grain |
| `data_quality_check` | Freshness, missing periods, sync gaps for the datasets used | api metadata, no tenant rows |

**Budget and stop rules (defaults are hypotheses, configurable per tenant):**

- At most `max_tool_calls` executions (default 6, unchanged from ADR-0006), `max_depth` = 2 drill levels, deadline 30 s.
- Stop when the identified contributors explain at least `coverage_threshold` (default 80%) of the total change, when no member contributes at least `min_contribution_share` (default 20%), when the budget is used up, or when a data quality check fails.
- Results of each step are reduced in code to **findings** (top contributors, shares, direction) before any LLM sees them.

**Who chooses the next step** is the core OPEN question in ADR-0010:
- (a) deterministic rules only, e.g. "drill into the largest contributor when its share is ≥ the threshold";
- (b) the LLM picks one step from the catalog, and code validates it against the budget, the authorized view and the stop rules;
- (c) keep the current behaviour: every breakdown is declared up front and nothing adaptive happens.

The recommendation is (a) for the MVP, with (b) only if evaluation shows a measurable gain.

**Security property:** a drill-down filter value, such as `branch = "Pune"`, comes from a previous authorized result, not from the user or the model. It is still sent as a parameter, and the api re-authorizes every step and injects ABAC filters. A step can therefore never widen scope.

### 3.4 Evidence-grounded diagnosis and explanation

Diagnosis ranks contributing factors by absolute contribution to the change. Contributions are computed in code. Each factor is a **finding** with evidence IDs **[ADR-0012]**. The LLM writes the narrative from findings and must label every statement as one of:

- **Verified fact:** directly in a result. Cites a `result` evidence ID.
- **Derived calculation:** computed in code. Cites a `derived` evidence ID with its formula.
- **Possible explanation (hypothesis):** a plausible cause. It is marked as supported, contradicted or **not testable with the connected data**, and cites the evidence it rests on. Causes outside the data, such as seasonality, a competitor or a festival, are always hypotheses and never facts.
- **Unknown:** what could not be determined, and why (missing data, stale sync, budget exhausted, not authorized).

### 3.5 Evidence-based recommendations **[D-OPEN-23]**

A recommendation is allowed only if it cites at least one finding. Recommendations suggest something to investigate or act on, for example "review credit terms for the 5 customers holding 62% of overdue dues". They never trigger actions in customer systems (see Non-goals in PRODUCT.md). How recommendations are generated (template playbooks, LLM wording over findings, or a hybrid) is OPEN.

## 4. Interaction with deterministic query execution

```
ai-engine (orchestrator)                       api (trusted)
  step → QueryPlan(s) ──── execute-plan ─────▶ verify signed RequestContext
                                               validate plan vs published semantic version
                                               check grants; inject ABAC + tenant predicates
                                               exact cache lookup (D-08)
                                               compile → parameterized SQL, read-only tx,
                                               SET LOCAL app.tenant_id, timeout, row cap
  ◀── result_set_id, rows (bounded), ───────── audit
      sources, freshness, data_version
  compute findings + evidence in code
```

The orchestrator never receives SQL text, physical table names or row filter values. Any plan the api rejects (403 or validation error) ends the investigation branch. The rejection is recorded under `unknowns` as "not available for your access". It is never retried with a different scope.

## 5. Structured analytical conversation state **[ADR-0011]**

This replaces the free-text `conversation_summary` (contract `answer-response` v0.1.0) once ADR-0011 is accepted and the contract version is bumped. Until then, the existing contract applies.

```jsonc
// AnalyticalContext — illustrative, not a contract yet
{
  "semantic_model_version": 7,
  "focus": {
    "metrics": ["revenue"],
    "dimensions": ["branch.name"],
    "filters": [{ "dimension": "branch.name", "operator": "in", "values": ["Pune"] }],
    "time_range": { "relative": "last_month" },
    "comparison": { "type": "previous_period" }
  },
  "last_analysis_type": "diagnostic",
  "open_hypotheses": [{ "id": "h1", "text_ref": "...", "status": "not_testable" }],
  "evidence_refs": ["ev_3f2a", "ev_91c0"],   // IDs only, never values or rows
  "turn": 3
}
```

Rules:

- It holds semantic IDs, relative time tokens, filter values the user stated or that came from authorized results, and evidence **references**. It holds no result rows, no figures and no question text.
- The api stores it per conversation turn in a tenant-scoped table with RLS forced. It belongs to the user and tenant of the conversation.
- **On every turn the api re-validates the context against the user's current authorized view.** Items the user can no longer access are removed before the context reaches ai-engine. If the semantic model version changed, references are migrated where the IDs still exist, and otherwise the context is reset with an `unknowns` note.
- Follow-ups are resolved as a typed **delta** (from §3.1 `follow_up_type`) applied to the context in code. Example: "and what about Nashik?" is a `refine_filter` that replaces the branch filter. "Why?" is an `ask_why` that starts a diagnostic on the current focus.
- Relative time tokens are re-resolved on every turn from `resolved_now` (P-17), so "last month" stays correct across days.

## 6. Numerical provenance and evidence **[ADR-0012]**

Strict rule: **every number shown to a user has exactly one provenance record.** There is no other source of numbers.

| Provenance kind | Origin | Must record |
|---|---|---|
| `result` | A cell in an api result set | `result_set_id`, row key, column, `normalized_plan_hash`, `semantic_model_version`, `data_version`, `executed_at`, data sources |
| `derived` | A calculation in code | Formula ID from a code registry (e.g. `pct_change`, `share_of_total`, `contribution_to_delta`), input evidence IDs, rounding |
| `config` | A tenant-configured value | The configuration document and version (e.g. "overdue = more than 90 days past due" from the semantic model) |

- The orchestrator keeps an **evidence ledger** per request. Narrative text refers to numbers by evidence ID. The final text is rendered from the ledger in the tenant's number format (Indian grouping, lakh and crore). ADR-0012 decides whether the LLM writes placeholders such as `{{ev_3f2a}}` (recommended) or plain digits that are matched afterwards (current design). The grounding check stays in place as a second defence either way.
- An answer with any numeric token that has no evidence goes through one regeneration and is then degraded to facts only (current behaviour, ADR-0006).
- The evidence ledger is stored with the AI execution record under the tenant's retention policy. It holds references and values already shown to the user, never raw rows beyond the bounded result sets the user was authorized to see.

## 7. Observability additions

Each AI execution record also stores the investigation trace: the steps chosen, why each one was chosen (rule ID or catalog choice), the stop reason, budget used, coverage reached and evidence IDs. This follows the existing rules: no prompt or answer text and no result rows in logs or traces ([AI_ENGINEERING.md](../../AI_ENGINEERING.md#observability)).

## 8. What does not change

D-04 (the LLM never decides permissions), D-07's prohibition of uncontrolled loops and free-form tool selection, P-02 (no data-store access from ai-engine), P-03 (no raw LLM SQL), P-17 (no LLM date arithmetic), D-08 (cache identity) and all tenant isolation requirements in [SECURITY.md](../../SECURITY.md).
