# Semantic model contract (draft v0)

The **document** schema (what tenants configure and publish) is [schemas/semantic-model/semantic-model.schema.json](../../schemas/semantic-model/semantic-model.schema.json). This contract defines how components exchange **views** of it.

## Authorized semantic view (api → ai-engine)

A projection of one published semantic model version, filtered by the user's AuthorizationContext:

```json
{
  "semantic_model_version": 7,
  "tenant_settings": { "currency": "INR", "timezone": "Asia/Kolkata", "fiscal_year_start_month": 4 },
  "entities": [{ "id": "invoice", "label": "Invoice", "description": "..." }],
  "measures": [{ "id": "revenue", "label": "Revenue", "description": "...", "unit": "currency", "synonyms": ["sales", "turnover"], "default_time_dimension": "invoice.invoice_date" }],
  "dimensions": [{ "id": "branch.name", "label": "Branch", "type": "categorical", "synonyms": ["location"] }],
  "glossary": [{ "term": "dues", "maps_to": "measure:outstanding_receivables" }]
}
```

Rules:

- The view contains semantic IDs, labels, descriptions and synonyms. It contains **no physical table or column names**, no measure SQL, and no row filter values.
- Items the user is not granted are absent. They are not marked as hidden.
- Every view is tagged with its `semantic_model_version`, and every plan built from it must carry that same version.

## Versioning

Published versions are immutable (P-13). Publishing creates version `n+1` and emits `semantic_model.published` through the outbox. Conversations already in flight finish on the version in their RequestContext.
