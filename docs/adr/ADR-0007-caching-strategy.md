# ADR-0007: Caching strategy

- **Status:** Accepted (D-08, the cache identity rule). Proposed (P-07, the mechanisms).
- **Date:** 2026-11-10

| Item | Status |
|---|---|
| D-08 Cache identity includes tenant, authz scope, plan, semantic model version, data version and policy version. No embedding-only financial reuse | Accepted |
| P-07 The semantic cache returns candidate plans only. Results come only from the exact cache | Proposed |

## Context

LLM calls dominate cost and latency per answer. Business users often repeat or rephrase the same questions, such as "top customers by dues" and "who owes us the most". Caching is valuable but dangerous: serving one user's result to another user with a narrower scope, or serving results after the data changed, would be a correctness and security failure. Similar wording does not mean the same question: "revenue this month" and "revenue last month" embed very closely.

## Decision

Three mechanisms with separate responsibilities ([docs/ai/caching.md](../ai/caching.md)):

1. **Provider prompt caching.** Prompts are assembled stable-first so that providers that support prefix caching can reuse them. This affects cost and latency only.
2. **Exact result cache** (Redis, tenant-prefixed). Key = `H(tenant_id, authz_scope_hash, normalized_plan_hash, semantic_model_version, data_versions[], cache_policy_version)`. Entries are written only after successful validated execution. Data-version bumps from sync make old keys unreachable, and a TTL bounds memory.
3. **Semantic plan cache** (vector index per tenant). Maps a normalized question embedding to a previously validated plan, filtered by `authz_scope_hash` and `semantic_model_version`. Before embedding, time expressions are extracted deterministically and replaced by a placeholder. A hit needs similarity above the threshold **and** the same intent **and** the same extracted time token. It yields a **candidate plan** in relative-time form. That plan is then resolved (P-17), re-validated and executed through the exact cache (P-07). This prevents "revenue this month" from reusing a "revenue last month" plan.

**Exclusions:** live/federated results (unless the tenant policy sets a short TTL), plans touching PII- or sensitive-tagged fields, and degraded answers.

## Alternatives considered

- **Cache final answers by embedding similarity.** Rejected: wrong-period and wrong-scope errors.
- **Cache per user ID rather than per scope.** Safe but low hit rate. Scope hashing is equally safe for users with identical effective permissions.
- **No caching.** Simplest, but expensive at scale.

## Advantages

- Correctness does not depend on similarity thresholds.
- Invalidation is structural (versions in keys), not event-chasing.

## Disadvantages

- Normalizing plans (ordering of filters, canonical time ranges) must be exact, or hit rates suffer.
- The semantic cache still costs an embedding call per question.

## Security implications

- Keys always include the tenant and the authorization scope.
- The scope hash must cover every element of effective authorization: row filters, column masks and granted measures. Bugs here are isolation bugs, so isolation test TI-07 is mandatory.

## Consequences

- `data_version` per dataset must be maintained by sync (outbox, [ADR-0005](ADR-0005-synchronization-architecture.md)).
- Cache policy is tenant configuration ([cache-policy.schema.json](../../schemas/configuration/cache-policy.schema.json)).

## Revisit conditions

- The exact cache hit rate stays under 10% after pilots. Then re-examine plan normalization or drop the semantic cache.
- Any semantic cache false positive that reaches a user. Then raise the threshold or require intent and measure equality before accepting a hit.
