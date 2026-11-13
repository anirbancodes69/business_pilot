import { type Kysely, sql } from 'kysely';

// Canonical tables of the `wholesale_distribution` v0 template (docs/data/canonical-model.md, P-11).
// Every table carries tenant_id with forced RLS. Foreign keys include tenant_id, so a row can never
// reference another tenant's row. data_source_id has no foreign key until data sources exist (M4).
// The application role may read, insert and update (soft delete through deleted_at), never delete.
// bp_system has no grant here (TI-15).

type Col = [name: string, type: string];
interface Table {
  name: string;
  cols: Col[];
  refs?: Record<string, string>; // column -> referenced table
}

const t = 'text';
const money = 'numeric(18,2)';
const TABLES: Table[] = [
  {
    name: 'branch',
    cols: [
      ['code', t],
      ['name', t],
      ['city', t],
      ['state', t],
    ],
  },
  {
    name: 'supplier',
    cols: [
      ['name', t],
      ['code', t],
      ['city', t],
      ['state', t],
    ],
  },
  {
    name: 'customer',
    cols: [
      ['name', t],
      ['code', t],
      ['gstin', t],
      ['segment', t],
      ['city', t],
      ['state', t],
      ['branch_id', 'uuid'],
      ['account_owner_user_ref', t],
      ['credit_limit', money],
      ['credit_days', 'integer'],
    ],
    refs: { branch_id: 'branch' },
  },
  {
    name: 'product',
    cols: [
      ['sku', t],
      ['name', t],
      ['category', t],
      ['sub_category', t],
      ['brand', t],
      ['uom', t],
      ['hsn_code', t],
    ],
  },
  {
    name: 'invoice',
    cols: [
      ['number', t],
      ['invoice_date', 'date'],
      ['due_date', 'date'],
      ['customer_id', 'uuid'],
      ['branch_id', 'uuid'],
      ['status', t],
      ['currency', 'char(3)'],
      ['gross_amount', money],
      ['tax_amount', money],
      ['net_amount', money],
    ],
    refs: { customer_id: 'customer', branch_id: 'branch' },
  },
  {
    name: 'invoice_line',
    cols: [
      ['invoice_id', 'uuid'],
      ['product_id', 'uuid'],
      ['quantity', 'numeric(18,3)'],
      ['unit_price', money],
      ['discount_amount', money],
      ['net_amount', money],
      ['cost_amount', money],
    ],
    refs: { invoice_id: 'invoice', product_id: 'product' },
  },
  {
    name: 'payment',
    cols: [
      ['customer_id', 'uuid'],
      ['payment_date', 'date'],
      ['amount', money],
      ['currency', 'char(3)'],
      ['method', t],
      ['reference', t],
    ],
    refs: { customer_id: 'customer' },
  },
  {
    name: 'payment_allocation',
    cols: [
      ['payment_id', 'uuid'],
      ['invoice_id', 'uuid'],
      ['amount', money],
    ],
    refs: { payment_id: 'payment', invoice_id: 'invoice' },
  },
  {
    name: 'sales_order',
    cols: [
      ['number', t],
      ['order_date', 'date'],
      ['customer_id', 'uuid'],
      ['branch_id', 'uuid'],
      ['status', t],
      ['net_amount', money],
    ],
    refs: { customer_id: 'customer', branch_id: 'branch' },
  },
  {
    name: 'inventory_snapshot',
    cols: [
      ['snapshot_date', 'date'],
      ['product_id', 'uuid'],
      ['branch_id', 'uuid'],
      ['quantity_on_hand', 'numeric(18,3)'],
      ['stock_value', money],
    ],
    refs: { product_id: 'product', branch_id: 'branch' },
  },
];

function statementsFor(tbl: Table): string[] {
  const q = `analytics.${tbl.name}`;
  const refs = Object.entries(tbl.refs ?? {}).map(
    ([col, target]) =>
      `FOREIGN KEY (tenant_id, ${col}) REFERENCES analytics.${target} (tenant_id, id)`,
  );
  return [
    `CREATE TABLE ${q} (
       tenant_id uuid NOT NULL REFERENCES core.tenant(id),
       id uuid NOT NULL DEFAULT gen_random_uuid(),
       data_source_id uuid NOT NULL,
       source_key text NOT NULL,
       content_hash text,
       ${tbl.cols.map(([n, ty]) => `${n} ${ty}`).join(',\n       ')},
       ext jsonb NOT NULL DEFAULT '{}'::jsonb,
       synced_at timestamptz NOT NULL DEFAULT now(),
       deleted_at timestamptz,
       PRIMARY KEY (tenant_id, id),
       UNIQUE (tenant_id, data_source_id, source_key)
       ${refs.length ? ',\n       ' + refs.join(',\n       ') : ''}
     )`,
    `ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${q}
       USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
    `GRANT SELECT, INSERT, UPDATE ON ${q} TO bp_app`,
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw('CREATE SCHEMA analytics').execute(db);
  await sql.raw('GRANT USAGE ON SCHEMA analytics TO bp_app').execute(db);
  for (const tbl of TABLES) for (const s of statementsFor(tbl)) await sql.raw(s).execute(db);
}
