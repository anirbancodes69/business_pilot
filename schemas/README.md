# Configuration schemas

JSON Schemas (draft 2020-12) for the **tenant configuration documents** stored in the control plane. These are the source of truth for configuration. Runtime validators (Zod in `packages/config-schema`, Pydantic in ai-engine) must be generated from them or tested against them. Inter-component payloads live in [contracts/](../contracts/README.md) instead.

| Schema | Stored in | Approval required to activate |
|---|---|---|
| [tenant/access-policy.schema.json](tenant/access-policy.schema.json) | `core.access_policy` | Yes (tenant admin or owner) |
| [configuration/data-source.schema.json](configuration/data-source.schema.json) | `core.data_source` | Yes |
| [configuration/entity-mapping.schema.json](configuration/entity-mapping.schema.json) | `core.entity_mapping` | Yes (D-10) |
| [configuration/cache-policy.schema.json](configuration/cache-policy.schema.json) | `core.cache_policy` | Yes |
| [semantic-model/semantic-model.schema.json](semantic-model/semantic-model.schema.json) | `core.semantic_model` | Yes (publish) |

Not yet written: `ai-configuration.schema.json` (language, enabled intents, recommendation checks, quotas), planned for Milestone 6.

All schemas are at draft version 0.1.0, except the semantic model at 0.2.0 (ADR-0013). They will be refined during Milestones 2–4, and breaking changes before the first pilot are expected.
