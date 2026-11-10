# Caching — detailed design

Decision: [ADR-0007](../adr/ADR-0007-caching-strategy.md). Policy schema: [schemas/configuration/cache-policy.schema.json](../../schemas/configuration/cache-policy.schema.json). Not implemented.

## 1. Provider prompt caching

Goal: lower the cost and latency of repeated static prompt prefixes on providers that support it. It has no effect on correctness.

Prompt assembly order (most to least stable):

1. Stage system instructions (versioned, global).
2. Output JSON schema and few-shot examples (versioned, global).
3. Tenant semantic model summary for the user's authorized view (stable per `semantic_model_version` + `authz_scope_hash`).
4. Conversation summary.
5. Current question and context.

Rules: no timestamps, request IDs or other volatile values in segments 1–3. Mark cache breakpoints where the provider requires explicit markers. Measure cached-token ratios in `ai_execution`. Provider-specific minimum prefix sizes, TTLs and pricing must be confirmed when D-OPEN-01 is decided. Tenant content in segment 3 relies on the provider's cache being scoped to BusinessPilot's account; verify this in the provider's terms during D-OPEN-01.

## 2. Exact application cache

```
key   = "t:{tenant_id}:qc:" + SHA-256(
          tenant_id, authz_scope_hash, normalized_plan_hash,
          semantic_model_version, sorted(dataset_id:data_version …), cache_policy_version)
value = {result_sets, sources, freshness, created_at, compiler_version}
```

- **Write:** only after successful execution of a validated plan, and only if the policy allows it and no excluded field is touched.
- **Read:** in the api's `execute-plan`, *after* authorization re-checks (a cache hit never skips authorization).
- **Invalidation:** structural. Any sync that changes a dataset bumps `data_version`, so new keys differ. Publishing a semantic model or policy changes their versions. TTL (default 24 h for managed sync) bounds memory and covers missed bumps.
- **Live/federated sources:** disabled by default. If enabled, `data_version` is replaced by a time bucket and the TTL is short (for example 5 minutes).

## 3. Semantic plan cache

Purpose: skip planning for rephrased questions.

```
index  = "idx:t:{tenant_id}:plancache"
fields = embedding(normalized_question), authz_scope_hash (TAG), semantic_model_version (TAG),
         intent (TAG), plan (JSON), plan_hash, hit_count, created_at
```

Normalization: a deterministic extractor pulls time expressions out of the question ("this month", "Q2", "since April") into a time token and replaces them with `{TIME}`. Then the text is lower-cased and whitespace-normalized. ai-engine embeds the result (P-16) and passes the vector to the `semantic-cache-lookup` tool.

Lookup: KNN filtered by tenant index + `authz_scope_hash` + `semantic_model_version` + the classified intent. Accept only if similarity ≥ threshold (default 0.95, tuned by evaluation) **and** the extracted time token is identical. The cached plan is stored in relative-time form and is re-resolved for the current date. A hit yields a candidate plan → plan validation → `execute-plan` (exact cache). The answer narrative is regenerated (cheap) or reused only if the result hash is identical.

Store: after a successful answer that passed the grounding check. Evict the entry when a user gives negative feedback on an answer that came from it.

## Exclusions

- Plans touching fields tagged `pii` or `sensitive` in the semantic model, unless the tenant policy explicitly allows it.
- Answers that failed grounding or were degraded.
- Questions in an `out_of_scope` or `clarify` intent.
- Any request whose tenant cache policy is `disabled`.

## Metrics

Hit rates per layer, cached-token ratio, false-positive reports (user flagged a wrong answer after a semantic hit), cache memory per tenant.
