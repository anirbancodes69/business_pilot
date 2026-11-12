# Tenant and control-plane model

These are the control-plane entities (PostgreSQL schema `core`). Implemented in Milestone 2: `tenant` (plus `key_id` and `wrapped_data_key`), `app_user`, `tenant_membership`, `role`, `permission`, `role_permission`, `membership_role`, `access_policy` (table only, not evaluated yet) and `audit_event`. All other entities are still proposed. Every entity except `tenant`, `app_user` and platform tables carries `tenant_id` and is RLS-protected.

| Entity | Key fields | Notes |
|---|---|---|
| `tenant` | id, name, slug, status, region, plan, template_id, created_at | Status: `provisioning`, `active`, `suspended`, `deleting`, `deleted` |
| `app_user` | id, idp_subject, email, display_name, status | Global identity. No tenant data |
| `tenant_membership` | tenant_id, user_id, status, attributes (jsonb) | Attributes feed ABAC, e.g. `assigned_branch_ids`, `employee_id`. Has the extra own-membership RLS policy for login (P-15) |
| `role` | tenant_id (nullable for system roles), key, name | System roles: owner, tenant_admin, finance_manager, sales_manager, sales_executive, viewer |
| `permission` | key | e.g. `entity:invoice:read`, `measure:gross_margin:read`, `data_source:manage`, `semantic_model:publish` |
| `role_permission`, `membership_role` | links | |
| `access_policy` | tenant_id, version, document (jsonb), status | Validated by [access-policy.schema.json](../../schemas/tenant/access-policy.schema.json) |
| `data_source` | tenant_id, type, access_mode, config (jsonb), credential_ref, status | Validated by [data-source.schema.json](../../schemas/configuration/data-source.schema.json) |
| `connector_credential` | tenant_id, id, ciphertext, wrapped_data_key, key_id, created_by, rotated_at | Never returned by any API |
| `entity_mapping` | tenant_id, data_source_id, version, document, status, approved_by, approved_at | Lifecycle in [canonical-model.md](../data/canonical-model.md) |
| `semantic_model` | tenant_id, version, document, status (`draft`, `published`, `retired`), published_by | Immutable once published |
| `ai_configuration` | tenant_id, version, document | Language, answer style, enabled intents, quotas |
| `cache_policy` | tenant_id, version, document | Validated by [cache-policy.schema.json](../../schemas/configuration/cache-policy.schema.json) |
| `dataset` | tenant_id, data_source_id, canonical_entity, data_version, last_successful_sync_at, status | Freshness and cache data version |
| `sync_job`, `sync_run`, `sync_checkpoint`, `sync_dead_letter` | tenant_id, … | See [sync-engine.md](../data/sync-engine.md) |
| `outbox_event` | id, tenant_id, type, payload (IDs only), created_at, published_at | Transactional outbox |
| `conversation`, `conversation_turn` | tenant_id, user_id, … | Retention per tenant |
| `ai_execution` | tenant_id, request_id, intent, plan_hash, prompt_versions, model_ids, tokens, cost, latencies, cache_flags, grounding_result | No raw rows |
| `audit_event` | tenant_id, actor_id, action, target, metadata, occurred_at | Append-only |

## Tenant lifecycle

`provisioning` (create the tenant, its owner membership, default roles, the template's semantic model draft and a per-tenant data key) → `active` → optionally `suspended` (read-only, sync paused) → `deleting` (deletion job, [data-handling.md](../security/data-handling.md)) → `deleted` (tombstone row with no data).

## Effective authorization

`membership roles → permissions` (RBAC) + `access_policy` evaluated against `membership.attributes` (ABAC) = `AuthorizationContext` ([contracts/tenant/authorization-context.schema.json](../../contracts/tenant/authorization-context.schema.json)). `authz_scope_hash = SHA-256(canonical JSON of the granted entities, measures and dimensions, row filters with resolved values, column masks, policy version)`.
