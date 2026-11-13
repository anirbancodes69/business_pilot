import { describe, expect, it } from 'vitest';
import type { DiscoveredField, DiscoveredObject } from '../src/connectors/connector';
import { ENTITIES } from '../src/mapping/canonical-catalog';
import { suggestMapping, tokens } from '../src/mapping/suggester';

const f = (name: string, data_type = 'text', nullable = false): DiscoveredField => ({
  name,
  data_type,
  nullable,
  is_primary_key: false,
});
const sheet = (name: string, fields: DiscoveredField[]): DiscoveredObject => ({
  name,
  kind: 'sheet',
  fields,
  estimated_rows: 10,
});
const targets = (s: ReturnType<typeof suggestMapping>) =>
  Object.fromEntries((s.mapping?.field_mappings ?? []).map((m) => [m.target, m.source]));

describe('tokens', () => {
  it('splits, lower-cases, expands short forms and singularizes', () => {
    expect(tokens('Inv No')).toEqual(['invoice', 'number']);
    expect(tokens('customerID')).toEqual(['customer', 'id']);
    expect(tokens('Credit_Limit (INR)')).toEqual(['credit', 'limit', 'inr']);
    expect(tokens('Items')).toEqual(['item']);
    expect(tokens('Qty')).toEqual(['quantity']);
  });
});

describe('heuristic mapping suggestions', () => {
  it('maps a customer master', () => {
    const s = suggestMapping(
      sheet('Customer Master', [
        f('Party Code'),
        f('Party Name'),
        f('GSTIN'),
        f('City'),
        f('State'),
        f('Credit Limit', 'numeric'),
        f('Credit Days', 'integer'),
        f('Sales Rep'),
      ]),
      ['Party Code'],
      'fp',
    );
    expect(s.mapping?.canonical_entity).toBe('customer');
    expect(targets(s)).toMatchObject({
      code: 'Party Code',
      name: 'Party Name',
      gstin: 'GSTIN',
      city: 'City',
      state: 'State',
      credit_limit: 'Credit Limit',
      credit_days: 'Credit Days',
      account_owner_user_ref: 'Sales Rep',
    });
    expect(s.mapping?.key_fields).toEqual(['Party Code']);
    expect(s.mapping?.suggestion_method).toBe('heuristic');
    expect(s.mapping?.status).toBe('suggested');
  });

  it('maps an invoice register, with abbreviations and a text date', () => {
    const s = suggestMapping(
      sheet('Sales Invoices', [
        f('Inv No'),
        f('Inv Date', 'text'),
        f('Party Code'),
        f('Gross Amt', 'numeric'),
        f('GST Amt', 'numeric'),
        f('Net Amt', 'numeric'),
        f('Status'),
      ]),
      ['Inv No'],
      'fp',
    );
    expect(s.mapping?.canonical_entity).toBe('invoice');
    expect(targets(s)).toMatchObject({
      number: 'Inv No',
      invoice_date: 'Inv Date',
      customer_id: 'Party Code',
      gross_amount: 'Gross Amt',
      tax_amount: 'GST Amt',
      net_amount: 'Net Amt',
      status: 'Status',
    });
    const date = s.mapping?.field_mappings.find((m) => m.target === 'invoice_date');
    expect(date?.transforms?.map((t) => t.op)).toEqual(['parse_date']);
    const ref = s.mapping?.field_mappings.find((m) => m.target === 'customer_id');
    expect(ref?.transforms).toEqual([{ op: 'lookup_ref', args: { entity: 'customer' } }]);
  });

  it('tells invoice lines from invoices', () => {
    const s = suggestMapping(
      sheet('Invoice Items', [
        f('Invoice No'),
        f('Item Code'),
        f('Qty', 'numeric'),
        f('Rate', 'numeric'),
        f('Discount', 'numeric'),
        f('Amount', 'numeric'),
      ]),
      ['Invoice No'],
      'fp',
    );
    expect(s.mapping?.canonical_entity).toBe('invoice_line');
    expect(targets(s)).toMatchObject({
      invoice_id: 'Invoice No',
      product_id: 'Item Code',
      quantity: 'Qty',
      unit_price: 'Rate',
      discount_amount: 'Discount',
      net_amount: 'Amount',
    });
  });

  it('maps payments and stock', () => {
    const pay = suggestMapping(
      sheet('Receipts', [
        f('Receipt Date', 'date'),
        f('Party Code'),
        f('Amount', 'numeric'),
        f('Mode'),
      ]),
      ['Receipt Date'],
      'fp',
    );
    expect(pay.mapping?.canonical_entity).toBe('payment');
    expect(targets(pay)).toMatchObject({
      payment_date: 'Receipt Date',
      amount: 'Amount',
      method: 'Mode',
    });

    const stock = suggestMapping(
      sheet('Closing Stock', [
        f('As On', 'date'),
        f('Item Code'),
        f('Godown'),
        f('Closing Qty', 'numeric'),
      ]),
      ['Item Code'],
      'fp',
    );
    expect(stock.mapping?.canonical_entity).toBe('inventory_snapshot');
    expect(targets(stock)).toMatchObject({
      snapshot_date: 'As On',
      product_id: 'Item Code',
      branch_id: 'Godown',
      quantity_on_hand: 'Closing Qty',
    });
  });

  it('suggests nothing for a sheet that does not fit, and lists what it considered', () => {
    const s = suggestMapping(sheet('Random notes', [f('Foo'), f('Bar'), f('Baz')]), ['Foo'], 'fp');
    expect(s.mapping).toBeNull();
    expect(s.confidence).toBe(0);
    expect(s.alternatives.length).toBeGreaterThan(0);
  });

  it('uses each column once and never maps a column to an incompatible type', () => {
    const s = suggestMapping(
      sheet('Invoices', [f('Invoice No'), f('Invoice Date', 'integer'), f('Amount', 'numeric')]),
      ['Invoice No'],
      'fp',
    );
    // An integer column cannot become a date, so invoice_date stays unmapped.
    expect(targets(s)).not.toHaveProperty('invoice_date');
    const sources = (s.mapping?.field_mappings ?? []).map((m) => m.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('carries the catalog tags, and money fields are tagged financial', () => {
    const s = suggestMapping(
      sheet('Customers', [f('Name'), f('GSTIN'), f('Credit Limit', 'numeric')]),
      ['Name'],
      'fp',
    );
    const byTarget = Object.fromEntries(
      (s.mapping?.field_mappings ?? []).map((m) => [m.target, m]),
    );
    expect(byTarget.gstin?.tags).toEqual(['pii']);
    expect(byTarget.credit_limit?.tags).toEqual(['financial']);
  });

  it('is deterministic and reads no cell values (only names and types)', () => {
    const object = sheet('Customers', [f('Name'), f('Code')]);
    expect(suggestMapping(object, ['Code'], 'fp')).toEqual(suggestMapping(object, ['Code'], 'fp'));
  });

  it('the catalog has every template entity with a required attribute', () => {
    expect(ENTITIES.map((e) => e.name).sort()).toEqual(
      [
        'branch',
        'customer',
        'inventory_snapshot',
        'invoice',
        'invoice_line',
        'payment',
        'payment_allocation',
        'product',
        'sales_order',
        'supplier',
      ].sort(),
    );
    for (const e of ENTITIES)
      expect(
        e.attributes.some((a) => a.required),
        e.name,
      ).toBe(true);
  });
});
