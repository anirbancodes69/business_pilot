# Canonical business model and mapping

Decision: [ADR-0002](../adr/ADR-0002-data-storage-strategy.md) (P-11). The `wholesale_distribution` v0 tables exist in `analytics` (migration 0004) and a default semantic model exists as code (`apps/api/src/configuration/templates/`). The mapping workflow (suggest, review, approve, activate) is implemented in Milestone 4 (`apps/api/src/mapping/`); sync is not.

## Industry templates

A template is a versioned set of canonical entities, default measures and default dimensions. Tenants activate the entities they have. Entities are **not** mandatory.

### `wholesale_distribution` v0 (hypothesis, to validate with customers)

| Entity | Core typed columns (besides `tenant_id`, `id`, `data_source_id`, `source_key`, `content_hash`, `ext`, `synced_at`, `deleted_at`) |
|---|---|
| `customer` | name, code, gstin (PII-tagged as business identifier), segment, city, state, branch_id, account_owner_user_ref, credit_limit, credit_days |
| `product` | sku, name, category, sub_category, brand, uom, hsn_code |
| `branch` | code, name, city, state |
| `supplier` | name, code, city, state |
| `invoice` | number, invoice_date, due_date, customer_id, branch_id, status, currency, gross_amount, tax_amount, net_amount |
| `invoice_line` | invoice_id, product_id, quantity, unit_price, discount_amount, net_amount, cost_amount (nullable) |
| `payment` | customer_id, payment_date, amount, currency, method, reference |
| `payment_allocation` | payment_id, invoice_id, amount (optional, when the source has it) |
| `sales_order` | number, order_date, customer_id, branch_id, status, net_amount |
| `inventory_snapshot` | snapshot_date, product_id, branch_id, quantity_on_hand, stock_value |

MVP subset: customer, product, branch, invoice, invoice_line, payment (see [PRODUCT.md](../../PRODUCT.md#mvp-scope-the-first-vertical-slice)).

Default measures (examples, finalized in Milestone 3): `revenue`, `invoice_count`, `gross_margin` (needs `cost_amount`), `gross_margin_pct`, `outstanding_receivables` (invoice net minus allocated payments; falls back to customer-level balance when no allocation data exists, and the answer states this method), `overdue_receivables`, `days_sales_outstanding`, `units_sold`, `average_order_value`.

Indian-context conventions: INR as the default currency, Indian financial year (April–March) as a time grain alongside the calendar year, GST fields as attributes, and number formatting in lakh/crore in the UI (display only; values are stored as numbers).

## Mapping document

Each data source object maps to one canonical entity through an `entity_mapping` document ([schemas/configuration/entity-mapping.schema.json](../../schemas/configuration/entity-mapping.schema.json)): source object, key fields, field-to-attribute mappings with transforms (cast, trim, date parse with format, currency, value maps such as `"Cancelled" → cancelled`), row filters (for example, exclude test customers), and excluded columns.

## AI-assisted mapping workflow (D-10)

1. `discoverSchema` returns fields, types and sample statistics. Sample values are shown to the user; only column names, types and statistics go to the AI.
2. Suggestions come with a confidence score per field. Status: `suggested`. Today the api makes them from column names and types by name similarity (`suggestion_method: heuristic`) because the LLM provider is a dummy (ADR-0015); an ai-engine proposal is not wired yet.
3. A tenant admin reviews, edits and approves (`in_review` → `approved`). Low-confidence and money or date fields are highlighted.
4. Activation (`active`) triggers the initial sync and a new semantic model draft if measures need updating. Publishing that draft is a separate approval.
5. A later breaking schema drift moves the mapping to `needs_review` and pauses sync for that object.

Sample data shown during mapping is not stored beyond the review session.
