# Data handling, retention and deletion

Not implemented. Defaults are proposals pending legal review (D-OPEN-12). BusinessPilot makes no compliance claims.

## Data classes

| Class | Examples | Stored where | Sent to the LLM? |
|---|---|---|---|
| Configuration | Mappings, semantic models, policies | `core` | Semantic model summary only |
| Credentials | DB passwords, OAuth tokens | `core.connector_credential` (encrypted) | Never |
| Business records | Invoices, payments, customers | `analytics` (managed sync) or at the source (live mode) | Aggregates and bounded top-N rows. PII masked by default |
| Personal data | Contact names, phone numbers, emails in source data | Excluded from sync unless mapped and approved | Masked unless policy allows |
| Semantic content | Glossary, metric definitions, approved documents | Vector store + `core` | Yes, as retrieval context |
| Conversations | Questions, answers | `core.conversation_turn` | Current conversation summary only |
| Telemetry | Traces, metrics | Observability stack | Never. Telemetry contains no content |

## Minimization rules

- Users approve objects and columns explicitly. Unmapped columns are not synced.
- Columns tagged `pii` are excluded by default in mapping suggestions and need an explicit include.
- Sample values shown during mapping are not persisted.
- Only column names, types and statistics go to the LLM for mapping suggestions, never sample rows. "Statistics" means only: null rate, distinct count, min/max for numeric and date columns, value-length range, and detected format patterns (for example `date:DD-MM-YYYY`, `gstin-like`). Categorical values and top-k values are excluded, because they can contain personal or customer names.

## Retention (proposed defaults, configurable per tenant)

| Data | Default |
|---|---|
| Conversations | 180 days |
| `ai_execution` records (metadata, no content) | 365 days |
| Audit events | 365 days minimum |
| Uploaded files | Kept until replaced or deleted. The previous version is kept 30 days |
| Synced records with `deleted_at` | Purged 30 days after deletion |
| Dead-letter records | 30 days |

## Tenant deletion procedure

1. The owner requests deletion → re-authentication + confirmation → tenant `deleting`, access is blocked, sync is stopped.
2. Deletion job: drop `analytics` rows, `core` tenant rows (except a tombstone and minimal billing and audit records required by law), Redis keys and indexes with the tenant prefix, object storage prefix, credentials, and destroy the tenant data key (crypto-shredding).
3. Verify with TI-13-style checks, record an audit event, notify the owner.
4. Backups: data persists in backups until they age out under the backup retention window. Disclose this window in customer terms.

## Data residency

The target is an India region for Model A (D-OPEN-04). The LLM provider's processing location is part of D-OPEN-01 and D-OPEN-14 and must be disclosed to customers.
