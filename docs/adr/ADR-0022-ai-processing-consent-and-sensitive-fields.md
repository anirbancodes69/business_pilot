# ADR-0022: AI processing consent and sensitive fields

- **Status:** Proposed (2026-11-15), from the [LLM data processing review](../security/llm-data-processing-review.md).
- **Date:** 2026-11-15

## Context

Questions and result figures are sent to an external model provider. The data-handling rules said personal data is masked by default and that customers must be told, but nothing enforced either.

## Decision (proposed)

1. **Consent per workspace.** `core.tenant.ai_processing_enabled`, **off by default**. Only `PUT /v1/tenant/ai-processing` changes it, needs `tenant:manage` and `{"enabled": bool, "acknowledged": true}`, and is audited (`tenant.ai_processing_enabled` and `_disabled`). While it is off, `POST /v1/questions` answers 403 `ai_processing_disabled` before anything is built or sent. The web app shows a plain message.
2. **Sensitive fields.** Dimensions and measures tagged `pii` or `sensitive` in the semantic model are left out of the authorized view sent to ai-engine (`buildAuthorizedView(..., { forAi: true })`). The model cannot plan with them and never sees their members. The user's own view is unchanged.

## Consequences

- A new tenant must be switched on before the AI answers; the demo workspace was switched on through the endpoint.
- By default no field is tagged, so customer names still reach the model. Decision pending: pseudonymization, see the review.
- Not done: a screen for the switch, a tenant-level policy for "personal data allowed", per-user opt-out.
