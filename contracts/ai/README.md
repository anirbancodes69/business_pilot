# AI contracts (draft v0)

Decision: [ADR-0006](../../docs/adr/ADR-0006-ai-orchestration.md). Design: [docs/ai/orchestration-pipeline.md](../../docs/ai/orchestration-pipeline.md). All endpoints are internal and never exposed publicly. Transport is HTTP + JSON with service authentication.

## api → ai-engine

`POST /internal/v1/answer`

```json
{
  "request_context": "<signed opaque token>",
  "question": "Which customers have the highest outstanding payments?",
  "analytical_context": { "...": "optional, typed, see answer-response (D-21); re-validated by the api every turn" },
  "authorized_view": { "...": "see contracts/semantic-model" },
  "resolved_now": "2026-11-10T10:00:00+05:30",
  "locale": "en-IN"
}
```

Response: [answer-response.schema.json](answer-response.schema.json).

`POST /internal/v1/mapping-suggestions` (Milestone 4) takes discovered schema metadata (names, types and statistics as defined in [data-handling.md](../../docs/security/data-handling.md#minimization-rules), with no sample rows) plus the template. It returns suggested mappings with confidence scores.

`POST /internal/v1/embeddings` (Milestone 7, called by the worker's indexing job) takes `{tenant_id, items[{ref, text}]}` and returns `{embedding_model, vectors[{ref, vector}]}`. ai-engine does not store or log the text (P-16).

Conversation state (v0.2.0, D-21): the api stores the typed `analytical_context` returned with each `AnswerResponse`, re-validates it against the user's current authorized view on every turn, and sends it back. It holds semantic IDs, filters and evidence references, never rows, figures or question text. Numbers (v0.2.0, D-22): every number in an answer has one record in `evidence`; the model writes `{{ev_xxxx}}` placeholders and code renders the values.

## ai-engine → api (tool endpoints)

Every call carries the same `request_context`. The api verifies it and re-authorizes on every call.

| Endpoint | Request | Response |
|---|---|---|
| `POST /internal/v1/tools/execute-plan` | `{request_context, plan}` ([query-plan.schema.json](query-plan.schema.json)) | `{result_sets[], sources[], freshness[], truncated, cache_hit}` |
| `POST /internal/v1/tools/retrieve-context` (M7) | `{request_context, query_vector, embedding_model, kinds[], k}` | `{items[{kind, ref, text, score}]}` |
| `POST /internal/v1/tools/semantic-cache-lookup` (M8) | `{request_context, question_vector, embedding_model, intent, time_token}` | `{hit, plan?, similarity?}` |
| `POST /internal/v1/tools/semantic-cache-store` (M8) | `{request_context, question_vector, embedding_model, intent, time_token, plan}` | `{stored}` |

The api rejects vectors whose `embedding_model` differs from the one the tenant's index was built with.

Error codes: `401` invalid or expired context, `403` plan outside the authorized view, `422` invalid plan, `429` quota exceeded or `max_tool_calls` reached, `504` query timeout.

A `result_sets` item has the shape `{id, columns[{name, semantic_id, type, unit}], rows[][], row_count, result_hash}`. Rows sent to ai-engine are capped (top-N plus totals).
