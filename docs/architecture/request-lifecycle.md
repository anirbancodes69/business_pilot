# Request lifecycle and component communication

This expands [ARCHITECTURE.md §3](../../ARCHITECTURE.md#3-request-lifecycle-answering-a-question). Not implemented.

## Communication channels

| From → To | Channel | Auth | Contract |
|---|---|---|---|
| web → api | HTTPS REST (public) | User access token (OIDC) | `packages/api-contracts` (OpenAPI, planned) |
| api → ai-engine | HTTP REST (internal network only) | Service credential + signed RequestContext | [contracts/ai/](../../contracts/ai/) |
| ai-engine → api | HTTP REST internal tool endpoints | Service credential + the same RequestContext | [contracts/ai/](../../contracts/ai/) |
| api/worker → PostgreSQL | SQL | DB role (app role, no BYPASSRLS) | Migrations |
| api/worker → Redis | RESP | Password/ACL + TLS outside local development | Key conventions in [SECURITY.md §5](../../SECURITY.md#5-isolation-outside-postgresql) |
| api → worker | BullMQ jobs | — | Job payload schemas (Zod), always including `tenant_id` |
| worker → customer sources | Source protocol | Tenant connector credential | [contracts/connector/](../../contracts/connector/) |
| ai-engine → LLM / embedding provider | HTTPS | Provider key (ai-engine secret only) | `LlmProvider`, `EmbeddingProvider` ports |
| worker → ai-engine | HTTP REST internal (`/internal/v1/embeddings`, M7) | Service credential | [contracts/ai/](../../contracts/ai/) |

ai-engine is never reachable from the public internet.

## RequestContext

The api issues a RequestContext for each question ([contracts/tenant/request-context.schema.json](../../contracts/tenant/request-context.schema.json)) containing `request_id`, `tenant_id`, `user_id`, `authz_scope_hash`, `semantic_model_version`, `issued_at` and `expires_at`. It is signed with an api-held key. The scheme (HMAC or asymmetric) and the service-to-service authentication method are D-OPEN-15. ai-engine treats it as opaque and returns it on every tool call. The api verifies the signature and expiry, then **reloads the AuthorizationContext from its own state** using the IDs in the token. The token identifies the request; it does not carry the permissions themselves.

## Sequence (managed-sync source, cache miss)

```
User      web        api                         ai-engine                 Postgres/Redis
 │ ask ─▶ │ POST ─▶  │ authn, membership, authz   │                          │
 │        │          │ authorized view, ctx sign  │                          │
 │        │          │ POST /internal/v1/answer ─▶│ guard, intent            │
 │        │          │◀─ tool: retrieve-context ──│                          │
 │        │          │── vector search (tenant) ──┼────────────────────────▶ │
 │        │          │── context ────────────────▶│ plan, validate           │
 │        │          │◀─ tool: execute-plan ──────│                          │
 │        │          │ verify ctx, re-authz,      │                          │
 │        │          │ inject ABAC, exact cache?  │                          │
 │        │          │ compile SQL, SET LOCAL ────┼────────────────────────▶ │
 │        │          │ audit, results ───────────▶│ derive, explain, ground  │
 │        │          │◀─ AnswerResponse ──────────│                          │
 │        │ ◀─ 200 ──│ persist turn + ai_execution│                          │
```

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Plan invalid after repair | `clarify` answer listing the supported measures closest to the question |
| Plan references an unauthorized item | Rejected by the api (403 to ai-engine), answer: "You don't have access to X" without revealing data. Audited |
| Query timeout | A partial answer is not produced. The user is told to narrow the period or filters |
| Grounding failure after one regeneration | Facts-only answer (tables of verified results, no narrative) |
| ai-engine unavailable | api returns 503 with a retry hint. No fallback that bypasses the pipeline |
| Stale data beyond the freshness threshold | The answer is still given, with a prominent freshness warning in `unknowns` |
