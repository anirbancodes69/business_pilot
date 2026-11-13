import { describe, expect, it } from 'vitest';
import { ConnectorConfigError, SchemaError } from '../src/connectors/connector';
import { ExcelConnector } from '../src/connectors/excel/excel.connector';
import { assertSafeXlsx, MAX_UPLOAD_BYTES } from '../src/connectors/excel/zip-guard';
import { makeXlsx, zip } from './fixtures/xlsx';

const connector = new ExcelConnector();
const ctxFor = (file: Buffer | undefined) => ({
  tenantId: 't',
  dataSourceId: 'd',
  config: { upload_mode: 'manual' },
  credentials: undefined,
  deadline: Date.now() + 10_000,
  readUpload: () => Promise.resolve(file),
});

describe('Excel connector discovery (E4.2)', () => {
  const customers = [
    ['Customer ID', 'Name', 'Credit limit', 'Active', 'Since', 'Notes'],
    [1, 'Asha Traders', 50000, true, new Date('2024-04-01T00:00:00Z'), null],
    [2, 'Vikram Stores', 12500.5, false, new Date('2024-05-01T00:00:00Z'), 'prefers cash'],
    [3, 'Mehta & Sons', 0, true, new Date('2024-06-01T00:00:00Z'), null],
  ];

  it('infers types, nullability and key candidates, and reports exact row counts', async () => {
    const file = makeXlsx([{ name: 'Customers', rows: customers }]);
    const schema = await connector.discoverSchema(ctxFor(file));
    expect(schema.objects).toHaveLength(1);
    const sheet = schema.objects[0];
    expect(sheet).toMatchObject({ name: 'Customers', kind: 'sheet', estimated_rows: 3 });
    expect(sheet?.fields.map((f) => [f.name, f.data_type, f.nullable])).toEqual([
      ['Customer ID', 'integer', false],
      ['Name', 'text', false],
      ['Credit limit', 'numeric', false],
      ['Active', 'boolean', false],
      ['Since', 'date', false],
      ['Notes', 'text', true],
    ]);
    expect(sheet?.fields.some((f) => f.is_primary_key)).toBe(false);
    // Unique and never empty in every row. 'Active' repeats, 'Notes' has gaps.
    expect(sheet?.key_candidates).toEqual(['Customer ID', 'Name', 'Credit limit', 'Since']);
  });

  it('returns no cell values, only names and types', async () => {
    const file = makeXlsx([{ name: 'Customers', rows: customers }]);
    const text = JSON.stringify(await connector.discoverSchema(ctxFor(file)));
    for (const secret of ['Asha Traders', 'Vikram', 'prefers cash', '50000', 'Mehta'])
      expect(text).not.toContain(secret);
  });

  it('skips leading empty rows and empty sheets, and names blank or repeated headers', async () => {
    const file = makeXlsx([
      { name: 'Empty', rows: [] },
      {
        name: 'Items',
        rows: [
          [null, null],
          ['SKU', null, 'SKU', 'Qty'],
          ['a', 1, 'x', 1],
          ['b', 2, 'y', 2],
        ],
      },
    ]);
    const schema = await connector.discoverSchema(ctxFor(file));
    expect(schema.objects.map((o) => o.name)).toEqual(['Items']);
    expect(schema.objects[0]?.fields.map((f) => f.name)).toEqual([
      'SKU',
      'column_2',
      'SKU_2',
      'Qty',
    ]);
  });

  it('mixed columns fall back to text, and an empty table has no key candidates', async () => {
    const file = makeXlsx([
      { name: 'Mixed', rows: [['v'], [1], ['two'], [true]] },
      { name: 'Header only', rows: [['id']] },
    ]);
    const schema = await connector.discoverSchema(ctxFor(file));
    expect(schema.objects[0]?.fields[0]?.data_type).toBe('text');
    expect(schema.objects[1]).toMatchObject({ estimated_rows: 0, key_candidates: [] });
  });

  it('fingerprint ignores data but changes with columns and types', async () => {
    const base = await connector.discoverSchema(
      ctxFor(
        makeXlsx([
          {
            name: 'S',
            rows: [
              ['id', 'n'],
              [1, 'a'],
            ],
          },
        ]),
      ),
    );
    const sameShape = await connector.discoverSchema(
      ctxFor(
        makeXlsx([
          {
            name: 'S',
            rows: [
              ['id', 'n'],
              [7, 'b'],
              [8, 'c'],
            ],
          },
        ]),
      ),
    );
    const drift = await connector.discoverSchema(
      ctxFor(
        makeXlsx([
          {
            name: 'S',
            rows: [
              ['id', 'n', 'extra'],
              [1, 'a', 2],
            ],
          },
        ]),
      ),
    );
    expect(sameShape.fingerprint).toBe(base.fingerprint);
    expect(drift.fingerprint).not.toBe(base.fingerprint);
  });

  it('reports a missing file, and an unreadable workbook with a fixed message', async () => {
    expect(await connector.testConnection(ctxFor(undefined))).toEqual({
      ok: false,
      errors: ['no file has been uploaded'],
      privilege_warnings: [],
    });
    await expect(connector.discoverSchema(ctxFor(undefined))).rejects.toThrow(SchemaError);
    // Valid archive structure, but the sheet XML is broken and quotes content.
    const broken = zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook>SECRET-CELL-TEXT') },
    ]);
    const error = await connector.discoverSchema(ctxFor(broken)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as Error).message).toBe('the workbook could not be read');
  });

  it('takes no credentials and only the manual upload mode', () => {
    expect(connector.parseCredentials(undefined)).toBeUndefined();
    expect(() => connector.parseCredentials({ password: 'x' })).toThrow(ConnectorConfigError);
    expect(connector.parseConfig({ upload_mode: 'manual' })).toEqual({ upload_mode: 'manual' });
    expect(() => connector.parseConfig({ upload_mode: 'url' })).toThrow(ConnectorConfigError);
    expect(() => connector.parseConfig({ upload_mode: 'manual', url: 'http://x' })).toThrow(
      ConnectorConfigError,
    );
  });
});

describe('upload archive guard', () => {
  const ok = makeXlsx([{ name: 'S', rows: [['id'], [1]] }]);

  it('accepts a real workbook', () => {
    expect(() => assertSafeXlsx(ok)).not.toThrow();
  });

  it('rejects files that are not workbooks', () => {
    for (const bad of [
      Buffer.from('id,name\n1,a\n'),
      Buffer.alloc(10),
      Buffer.from('PK\x03\x04 not really a zip'),
      ok.subarray(0, ok.length - 10), // truncated: no end-of-directory record
      zip([{ name: 'readme.txt', data: Buffer.from('hi') }]), // a zip, but not a workbook
    ])
      expect(() => assertSafeXlsx(bad)).toThrow(SchemaError);
  });

  it('rejects a zip bomb by its declared size, before anything is decompressed', () => {
    const bomb = makeXlsx([{ name: 'S', rows: [['id'], [1]] }], {
      declaredSize: 4 * 1024 * 1024 * 1024 - 2, // just under the 32-bit limit, far over the cap
    });
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => assertSafeXlsx(bomb)).toThrow('expands too much');
  });

  it('rejects oversized files', () => {
    const big = Buffer.concat([ok, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(() => assertSafeXlsx(big)).toThrow('too large');
  });
});
