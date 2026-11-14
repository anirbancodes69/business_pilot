import { describe, expect, it } from 'vitest';
import type { MappingDocument } from '../src/mapping/mapping-document';
import { RowError, sourceKeyOf, transformRow } from '../src/sync/transform';

const mapping = (fieldMappings: MappingDocument['field_mappings']): MappingDocument => ({
  template: 'wholesale_distribution@0',
  canonical_entity: 'invoice',
  source_object: 'inv',
  key_fields: ['no'],
  field_mappings: fieldMappings,
  status: 'active',
});

const refs = (entity: string, key: string): string | null =>
  entity === 'customer' && key === '["C1"]' ? 'uuid-c1' : null;

const base = mapping([
  { target: 'number', source: 'no' },
  { target: 'invoice_date', source: 'dt', transforms: [{ op: 'parse_date' }] },
  { target: 'net_amount', source: 'amt', transforms: [{ op: 'parse_number' }] },
  { target: 'currency', source: 'cur', transforms: [{ op: 'currency' }] },
  {
    target: 'customer_id',
    source: 'cust',
    transforms: [{ op: 'lookup_ref', args: { entity: 'customer' } }],
  },
  {
    target: 'status',
    source: 'st',
    transforms: [{ op: 'lower' }, { op: 'value_map', args: { open: 'issued' } }],
  },
  { target: 'ext.route', source: 'route' },
]);

describe('transformRow', () => {
  const row = {
    no: 'INV-1',
    dt: '05/04/2025',
    amt: '₹1,250.50',
    cur: '',
    cust: 'C1',
    st: 'OPEN',
    route: 'R7',
  };

  it('maps, parses and resolves references', () => {
    const out = transformRow(row, base, refs);
    expect(out.sourceKey).toBe('["INV-1"]');
    expect(out.columns).toMatchObject({
      number: 'INV-1',
      invoice_date: '2025-04-05',
      net_amount: 1250.5,
      currency: 'INR',
      customer_id: 'uuid-c1',
      status: 'issued',
    });
    expect(out.ext).toEqual({ route: 'R7' });
    expect(out.unresolvedRefs).toEqual([]);
  });

  it('is deterministic and changes the hash when a mapped value changes', () => {
    const a = transformRow(row, base, refs);
    expect(transformRow({ ...row }, base, refs).contentHash).toBe(a.contentHash);
    expect(transformRow({ ...row, amt: '1251' }, base, refs).contentHash).not.toBe(a.contentHash);
    // An unmapped source column does not change the hash.
    expect(transformRow({ ...row, other: 'x' }, base, refs).contentHash).toBe(a.contentHash);
  });

  it('keeps the row and reports an unresolved reference', () => {
    const out = transformRow({ ...row, cust: 'C9' }, base, refs);
    expect(out.columns.customer_id).toBeNull();
    expect(out.unresolvedRefs).toEqual(['customer_id']);
  });

  it('rejects bad values with a field and a code, never the value', () => {
    try {
      transformRow({ ...row, amt: 'secret-12' }, base, refs);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RowError);
      expect((e as RowError).message).toBe('net_amount: bad_number');
      expect((e as RowError).message).not.toContain('secret');
    }
    expect(() => transformRow({ ...row, dt: '31/02/2025' }, base, refs)).toThrow(
      'invoice_date: bad_date',
    );
  });

  it('requires every key field', () => {
    expect(() => sourceKeyOf({ no: ' ' }, ['no'])).toThrow('no: key_missing');
    expect(sourceKeyOf({ a: 1, b: new Date('2025-01-02T00:00:00Z') }, ['a', 'b'])).toBe(
      '["1","2025-01-02T00:00:00.000Z"]',
    );
  });
});
