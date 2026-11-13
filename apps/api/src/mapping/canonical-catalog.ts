// Canonical entities of the `wholesale_distribution` v0 template (docs/data/canonical-model.md, P-11).
// Mirrors the `analytics` tables of migration 0004; an isolation test compares the two.
// Tags are fixed here and cannot be removed by a mapping: they decide what the AI may see later.

export const TEMPLATE_ID = 'wholesale_distribution@0';

export type AttributeType = 'text' | 'integer' | 'numeric' | 'date' | 'ref';
export type Tag = 'pii' | 'sensitive' | 'financial';

export interface Attribute {
  name: string;
  type: AttributeType;
  /** For `ref`: the canonical entity whose source key this column holds. */
  ref?: string;
  tags?: Tag[];
  /** Needed for the mapping to be approved. */
  required?: boolean;
  /** Other names customers commonly use. Matched together with the attribute name. */
  synonyms?: string[];
}

export interface Entity {
  name: string;
  /** Other names for the table or sheet as a whole. */
  synonyms: string[];
  attributes: Attribute[];
}

const text = (name: string, o: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'text',
  ...o,
});
const date = (name: string, o: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'date',
  ...o,
});
const money = (name: string, o: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'numeric',
  tags: ['financial'],
  ...o,
});
const num = (name: string, o: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'numeric',
  ...o,
});
const ref = (name: string, entity: string, o: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'ref',
  ref: entity,
  ...o,
});

export const ENTITIES: Entity[] = [
  {
    name: 'branch',
    synonyms: ['branch', 'outlet', 'warehouse', 'depot', 'location', 'godown'],
    attributes: [
      text('code', { synonyms: ['id', 'number'] }),
      text('name', { required: true }),
      text('city', { synonyms: ['town'] }),
      text('state', { synonyms: ['region'] }),
    ],
  },
  {
    name: 'supplier',
    synonyms: ['supplier', 'vendor', 'manufacturer', 'distributor'],
    attributes: [
      text('name', { required: true }),
      text('code', { synonyms: ['id', 'number'] }),
      text('city', { synonyms: ['town'] }),
      text('state', { synonyms: ['region'] }),
    ],
  },
  {
    name: 'customer',
    synonyms: ['customer', 'party', 'client', 'buyer', 'dealer', 'retailer', 'account'],
    attributes: [
      text('name', { required: true, synonyms: ['party name', 'customer name', 'firm'] }),
      text('code', { synonyms: ['id', 'number', 'party code'] }),
      text('gstin', { tags: ['pii'], synonyms: ['gst', 'gst number', 'gst no', 'tax id'] }),
      text('segment', { synonyms: ['type', 'channel', 'class'] }),
      text('city', { synonyms: ['town'] }),
      text('state', { synonyms: ['region'] }),
      ref('branch_id', 'branch', { synonyms: ['branch code', 'branch', 'outlet'] }),
      text('account_owner_user_ref', {
        tags: ['pii'],
        synonyms: ['account owner', 'salesperson', 'sales rep', 'executive', 'owner'],
      }),
      money('credit_limit', { synonyms: ['limit', 'credit'] }),
      {
        name: 'credit_days',
        type: 'integer',
        synonyms: ['credit period', 'payment terms', 'days'],
      },
    ],
  },
  {
    name: 'product',
    synonyms: ['product', 'item', 'sku', 'article', 'material', 'goods', 'stock item'],
    attributes: [
      text('sku', { synonyms: ['code', 'item code', 'product code', 'id', 'number'] }),
      text('name', { required: true, synonyms: ['item name', 'product name', 'description'] }),
      text('category', { synonyms: ['group', 'item group'] }),
      text('sub_category', { synonyms: ['subcategory', 'sub group'] }),
      text('brand', { synonyms: ['make', 'company'] }),
      text('uom', { synonyms: ['unit', 'unit of measure', 'pack'] }),
      text('hsn_code', { synonyms: ['hsn', 'hsn sac'] }),
    ],
  },
  {
    name: 'invoice',
    synonyms: ['invoice', 'bill', 'sales', 'sale', 'sales invoice', 'tax invoice'],
    attributes: [
      text('number', {
        required: true,
        synonyms: ['invoice no', 'bill no', 'invoice number', 'bill number', 'id'],
      }),
      date('invoice_date', { required: true, synonyms: ['date', 'bill date'] }),
      date('due_date', { synonyms: ['due on', 'payment due'] }),
      ref('customer_id', 'customer', { synonyms: ['party', 'party code', 'customer code'] }),
      ref('branch_id', 'branch', { synonyms: ['branch code', 'outlet'] }),
      text('status', { synonyms: ['state', 'payment status'] }),
      text('currency', { synonyms: ['curr', 'ccy'] }),
      money('gross_amount', { synonyms: ['gross', 'gross total', 'subtotal', 'taxable value'] }),
      money('tax_amount', { synonyms: ['tax', 'gst amount', 'gst'] }),
      money('net_amount', {
        required: true,
        synonyms: [
          'amount',
          'total',
          'invoice amount',
          'bill amount',
          'net total',
          'invoice value',
        ],
      }),
    ],
  },
  {
    name: 'invoice_line',
    synonyms: [
      'invoice line',
      'invoice item',
      'line item',
      'bill item',
      'bill detail',
      'sales item',
      'sales line',
      'invoice detail',
    ],
    attributes: [
      ref('invoice_id', 'invoice', {
        required: true,
        synonyms: ['invoice no', 'bill no', 'invoice number', 'bill number'],
      }),
      ref('product_id', 'product', { synonyms: ['sku', 'item code', 'product code', 'item'] }),
      num('quantity', { required: true, synonyms: ['qty', 'units', 'nos'] }),
      money('unit_price', { synonyms: ['rate', 'price', 'mrp'] }),
      money('discount_amount', { synonyms: ['discount', 'disc'] }),
      money('net_amount', { required: true, synonyms: ['amount', 'line total', 'total', 'value'] }),
      money('cost_amount', { synonyms: ['cost', 'cogs', 'purchase price'] }),
    ],
  },
  {
    name: 'payment',
    synonyms: ['payment', 'receipt', 'collection', 'receipts', 'remittance'],
    attributes: [
      ref('customer_id', 'customer', { synonyms: ['party', 'party code', 'customer code'] }),
      date('payment_date', { required: true, synonyms: ['date', 'receipt date', 'received on'] }),
      money('amount', { required: true, synonyms: ['received', 'paid', 'receipt amount'] }),
      text('currency', { synonyms: ['curr', 'ccy'] }),
      text('method', { synonyms: ['mode', 'payment mode', 'type'] }),
      text('reference', { synonyms: ['ref', 'utr', 'cheque no', 'transaction id', 'narration'] }),
    ],
  },
  {
    name: 'payment_allocation',
    synonyms: ['payment allocation', 'receipt allocation', 'settlement', 'adjustment', 'knock off'],
    attributes: [
      ref('payment_id', 'payment', { required: true, synonyms: ['receipt no', 'receipt number'] }),
      ref('invoice_id', 'invoice', {
        required: true,
        synonyms: ['invoice no', 'bill no', 'invoice number'],
      }),
      money('amount', { required: true, synonyms: ['allocated', 'adjusted', 'settled'] }),
    ],
  },
  {
    name: 'sales_order',
    synonyms: ['sales order', 'order', 'orders', 'purchase order', 'so'],
    attributes: [
      text('number', { required: true, synonyms: ['order no', 'order number', 'so no', 'id'] }),
      date('order_date', { required: true, synonyms: ['date', 'ordered on'] }),
      ref('customer_id', 'customer', { synonyms: ['party', 'party code', 'customer code'] }),
      ref('branch_id', 'branch', { synonyms: ['branch code', 'outlet'] }),
      text('status', { synonyms: ['state', 'order status'] }),
      money('net_amount', { synonyms: ['amount', 'total', 'order value', 'order amount'] }),
    ],
  },
  {
    name: 'inventory_snapshot',
    synonyms: [
      'inventory snapshot',
      'inventory',
      'stock',
      'stock position',
      'closing stock',
      'stock summary',
    ],
    attributes: [
      date('snapshot_date', { required: true, synonyms: ['date', 'as on', 'as of', 'stock date'] }),
      ref('product_id', 'product', {
        required: true,
        synonyms: ['sku', 'item code', 'product code', 'item'],
      }),
      ref('branch_id', 'branch', { synonyms: ['branch code', 'warehouse', 'godown', 'location'] }),
      num('quantity_on_hand', {
        required: true,
        synonyms: ['quantity', 'qty', 'closing qty', 'stock qty', 'on hand', 'balance'],
      }),
      money('stock_value', { synonyms: ['value', 'valuation', 'stock amount'] }),
    ],
  },
];

export function findEntity(name: string): Entity | undefined {
  return ENTITIES.find((e) => e.name === name);
}
