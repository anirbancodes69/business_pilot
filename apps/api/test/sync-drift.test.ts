import { describe, expect, it } from 'vitest';
import type { DiscoveredObject } from '../src/connectors/connector';
import type { MappingDocument } from '../src/mapping/mapping-document';
import { detectDrift, mappingHash } from '../src/sync/drift';

const mapping: MappingDocument = {
  template: 'wholesale_distribution@0',
  canonical_entity: 'customer',
  source_object: 't',
  key_fields: ['id'],
  field_mappings: [{ target: 'name', source: 'name' }],
  status: 'active',
};
const obj = (fields: [string, string][]): DiscoveredObject => ({
  name: 't',
  kind: 'table',
  estimated_rows: 1,
  fields: fields.map(([name, data_type]) => ({
    name,
    data_type,
    nullable: false,
    is_primary_key: false,
  })),
});

describe('detectDrift', () => {
  const before = { id: 'integer', name: 'text' };
  it('reports nothing for an identical schema', () => {
    const r = detectDrift(
      mapping,
      obj([
        ['id', 'integer'],
        ['name', 'text'],
      ]),
      before,
      true,
    );
    expect(r).toMatchObject({ breaking: [], additive: 0 });
  });
  it('treats a new column as additive', () => {
    const r = detectDrift(
      mapping,
      obj([
        ['id', 'integer'],
        ['name', 'text'],
        ['x', 'text'],
      ]),
      before,
      true,
    );
    expect(r).toMatchObject({ breaking: [], additive: 1 });
  });
  it('treats a missing mapped or key column, or a missing object, as breaking', () => {
    expect(detectDrift(mapping, obj([['id', 'integer']]), before, true).breaking).toEqual([
      'column_missing:name',
    ]);
    expect(detectDrift(mapping, obj([['name', 'text']]), before, true).breaking).toEqual([
      'column_missing:id',
    ]);
    expect(detectDrift(mapping, undefined, before, true).breaking).toEqual(['object_missing']);
  });
  it('flags a type change only when types are trustworthy', () => {
    const changed = obj([
      ['id', 'integer'],
      ['name', 'varchar'],
    ]);
    expect(detectDrift(mapping, changed, before, true).breaking).toEqual(['type_changed:name']);
    expect(detectDrift(mapping, changed, before, false).breaking).toEqual([]);
  });
  it('hashes a mapping deterministically and changes with it', () => {
    expect(mappingHash(mapping)).toBe(mappingHash({ ...mapping }));
    expect(mappingHash(mapping)).not.toBe(mappingHash({ ...mapping, key_fields: ['x'] }));
  });
});
