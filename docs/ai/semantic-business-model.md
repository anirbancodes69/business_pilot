# Semantic business model — design

**Status: design, not implemented.** The current configuration schema is [schemas/semantic-model/semantic-model.schema.json](../../schemas/semantic-model/semantic-model.schema.json) (draft v0). The extensions marked **[ADR-0013]** are proposals. They are not part of the schema until ADR-0013 is decided and the schema version is bumped.

Exchange contract (authorized view): [contracts/semantic-model/README.md](../../contracts/semantic-model/README.md). Orchestrator use: [analyst-orchestrator.md](analyst-orchestrator.md).

## 1. Why it matters

The semantic business model is BusinessPilot's core asset (PRODUCT.md). It is the only place where a business term gets a precise meaning. The LLM plans in semantic IDs and never sees physical tables (ADR-0006). The analyst can only investigate along paths the model declares. An investigation is only as good as the model's metric definitions, hierarchies and driver relationships.

## 2. Elements

### 2.1 Metrics (schema: `measures`)

| Property | In v0 schema | Purpose |
|---|---|---|
| `id`, `label`, `description`, `synonyms` | Yes | Identification and language matching |
| `entity`, `aggregation`, `attribute`, `filters` | Yes | Exact definition, compiled by the api |
| `numerator`, `denominator` (ratio) | Yes | Ratio metrics such as gross margin % |
| `expression_ref` (custom) | Yes | Vetted compiler-side expression, never free SQL |
| `unit`, `default_time_dimension`, `tags` | Yes | Formatting, time default, PII/financial tagging |
| `metric_type`: `simple`, `ratio`, `derived` | **No [ADR-0013]** | `derived` = formula over other metrics, evaluated by a code registry |
| `additivity`: `additive`, `semi_additive`, `non_additive` | **No [ADR-0013]** | Prevents wrong sums. Outstanding receivables is a balance (semi-additive over time). Margin % is non-additive |
| `polarity`: `higher_is_better`, `lower_is_better`, `neutral` | **No [ADR-0013]** | Needed for "performing poorly" and for recommendations |
| `valid_dimensions` | **No [ADR-0013]** | Dimensions that make sense for this metric. Limits planning and decomposition |
| `drivers` | **No [ADR-0013]** | Declared decomposition, e.g. `revenue = quantity × avg_net_price`. Used by `driver_decomposition` |
| `business_definition`, `owner`, `certified` | **No [ADR-0013]** | The human-readable definition shown to users, who owns it, and whether a tenant admin approved it |

### 2.2 Dimensions (schema: `dimensions`)

Present today: `id`, `label`, `entity`, `attribute`, `type`, `synonyms`, `tags`. Proposed **[ADR-0013]**:

- `hierarchy`: ordered levels, e.g. `region → branch`, `category → subcategory → product`. `drill_into_member` follows these.
- `diagnostic`: whether the dimension is a useful axis for explaining changes. Customer, branch and category are useful; invoice number is not.
- `member_synonyms`: tenant-specific names for members, e.g. "Pune main" for "PUNE-01". These are approved by a human like every other mapping (D-10).

### 2.3 Relationships (schema: `relationships`)

Present today: `from`, `to`, `on`, `cardinality`. They define the only join paths the compiler may use. No change is proposed, except a validation rule that every `drivers` and `valid_dimensions` reference must be reachable through declared relationships.

### 2.4 Business definitions (schema: `glossary`, `settings`)

- Glossary terms map business language to semantic IDs ("dues" → `measure:outstanding_receivables`).
- Settings carry currency, timezone, fiscal year start and number format.
- Proposed **[ADR-0013]**: named **business rules** with parameters, e.g. `overdue_days = 90` and `slow_moving_days = 120`. Numbers that come from these rules appear in answers with `config` provenance ([analyst-orchestrator.md §6](analyst-orchestrator.md#6-numerical-provenance-and-evidence-adr-0012)).

## 3. Governance (unchanged rules)

- AI-suggested mappings and semantic model changes stay inactive until a human approves them (D-10).
- Published versions are immutable (P-13). Every plan, cache entry, evidence record and conversation context carries `semantic_model_version`.
- The authorized view sent to ai-engine contains only granted items, and no physical names, SQL or row filter values.
- Metric definitions and numeric defaults in the wholesale-distribution template are unvalidated hypotheses until pilot customers confirm them.

## 4. Gap summary (for ADR-0013)

| Needed for | Missing in v0 |
|---|---|
| Correct aggregation across time and dimensions | `additivity` |
| "Which branches are performing poorly?" | `polarity` |
| Multi-step investigation along meaningful paths | `hierarchy`, `diagnostic`, `valid_dimensions` |
| Price, volume and mix explanations | `drivers`, `metric_type: derived` |
| Explaining definitions to users | `business_definition`, `certified` |
| Configurable thresholds with provenance | Business rules in settings |
