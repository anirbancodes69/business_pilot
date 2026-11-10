# Contracts

This folder defines the **interface contracts between components**: messages, operations and payloads exchanged across a boundary (api ↔ ai-engine, sync engine ↔ connector, api ↔ worker).

How the related folders divide the work:

| Folder | Holds | Source of truth for |
|---|---|---|
| `contracts/` | Interface contracts (Markdown + JSON Schema) | Inter-component payloads |
| `schemas/` | JSON Schemas for **configuration documents** stored per tenant | Tenant configuration (data sources, mappings, policies, semantic models) |
| `packages/config-schema` (planned) | Zod validators and TS types **generated** from `schemas/` | Nothing (generated) |
| `packages/api-contracts` (planned) | OpenAPI specs for public and internal HTTP APIs, and generated clients | HTTP surface. Its payload shapes must reference `contracts/` |
| `packages/shared-types` (planned) | Hand-written TS types shared by web and api that are not covered above | UI and API shared types |

Rules:

- JSON Schema draft 2020-12. Each schema has `$id` (`urn:businesspilot:...`) and a `version` in `$comment` or `x-version`.
- Breaking changes create a new major version. Record compatibility in the folder's README.
- Python (Pydantic) and TypeScript (Zod) models must be generated from these schemas or validated against them in CI. Hand-maintained divergent copies are not allowed.

| Contract | Status |
|---|---|
| [connector/](connector/) | Draft v0 |
| [tenant/](tenant/) | Draft v0 |
| [semantic-model/](semantic-model/) | Draft v0 (document schema in [schemas/semantic-model/](../schemas/semantic-model/)) |
| [ai/](ai/) | Draft v0 |
