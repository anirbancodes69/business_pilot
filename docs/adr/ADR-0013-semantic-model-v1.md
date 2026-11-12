# ADR-0013: Semantic model v1 extensions

- **Status:** OPEN (awaiting product-owner decision)
- **Date:** 2026-11-13
- **Decision items:** D-OPEN-22

## Context

The semantic model schema v0 ([schemas/semantic-model/semantic-model.schema.json](../../schemas/semantic-model/semantic-model.schema.json)) supports entities, relationships, measures (including ratio and vetted custom expressions), dimensions, a glossary and tenant settings. Analyst capabilities need more:

- additivity, so semi-additive balances such as outstanding receivables are not summed over time;
- polarity, for "performing poorly";
- dimension hierarchies and a diagnostic flag, for drilling;
- metric drivers, for price, volume and mix explanations;
- written business definitions with certification;
- parameterized business rules such as the overdue threshold.

Gap table: [docs/ai/semantic-business-model.md §4](../ai/semantic-business-model.md#4-gap-summary-for-adr-0013).

## Decision (proposed)

Extend the schema to v1 with: `metric_type` (simple, ratio, derived), `additivity`, `polarity`, `valid_dimensions`, `drivers`, `business_definition`, `owner` and `certified` on metrics; `hierarchy`, `diagnostic` and `member_synonyms` on dimensions; and named `business_rules` in settings. Derived metrics refer to formulas in a code registry, never to free expressions.

Options:

| Option | Description |
|---|---|
| A | Add all extensions before the wholesale template is published in Milestone 3 (recommended: one template migration) |
| B | Add only additivity, polarity and hierarchy in Milestone 3; drivers and business rules in Milestone 6 |
| C | Keep v0; encode investigation paths in orchestrator code per template |

**Recommendation:** A. C puts business semantics in code, which contradicts configuration-driven design.

## Alternatives considered

- **Adopt an external semantic layer product or specification.** It adds a dependency and infrastructure. Out of scope without a separate ADR.

## Advantages

- Investigation paths and recommendations are driven by configuration, not hard-coded per industry.

## Disadvantages

- A larger schema to validate, author and approve. Template authoring effort grows.

## Security implications

- The authorized view must still exclude physical names, SQL and row filter values. New fields carry semantic IDs and text only.
- Member synonyms map to data values and need the same human approval as mappings (D-10).

## Consequences

- Schema version bump, with Zod and Pydantic validators updated together (contracts/README.md).
- The plan compiler enforces additivity (for example, refuses to sum a semi-additive metric over time).

## Revisit conditions

- Pilot tenants need semantics the v1 schema cannot express.
