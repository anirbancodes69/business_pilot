import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { ExcelConnector } from '../../src/connectors/excel/excel.connector';
import type { DataSourceService } from '../../src/connectors/data-source.service';
import type { MappingDocument } from '../../src/mapping/mapping-document';
import { SyncAlreadyRunningError, SyncService } from '../../src/sync/sync.service';
import { makeXlsx } from '../fixtures/xlsx';
import { createFixture, type Fixture } from './harness';

// E5.1 (full snapshot): idempotent upserts, content hash, references, dead letters, data_version,
// outbox, and tenant isolation of every new table.

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(async () => {
  await f.close();
});

const customers = [
  ['Party Code', 'Party Name', 'City'],
  ['C001', 'Asha Traders', 'Pune'],
  ['C002', 'Vikram Stores', 'Nashik'],
];
const invoices = [
  ['Inv No', 'Inv Date', 'Party Code', 'Net Amt'],
  ['INV-1', '2026-04-02', 'C001', '11,800'],
  ['INV-2', '2026-04-05', 'C002', 5900],
  ['INV-3', 'not a date', 'C001', 100],
  ['INV-4', '2026-04-06', 'C404', 50],
];

const doc = (
  entity: string,
  object: string,
  key: string,
  fields: MappingDocument['field_mappings'],
): MappingDocument => ({
  template: 'wholesale_distribution@0',
  canonical_entity: entity,
  source_object: object,
  key_fields: [key],
  field_mappings: fields,
  status: 'active',
});
const customerDoc = doc('customer', 'Customers', 'Party Code', [
  { target: 'code', source: 'Party Code' },
  { target: 'name', source: 'Party Name' },
  { target: 'city', source: 'City' },
]);
const invoiceDoc = doc('invoice', 'Invoices', 'Inv No', [
  { target: 'number', source: 'Inv No' },
  { target: 'invoice_date', source: 'Inv Date', transforms: [{ op: 'parse_date' }] },
  {
    target: 'customer_id',
    source: 'Party Code',
    transforms: [{ op: 'lookup_ref', args: { entity: 'customer' } }],
  },
  { target: 'net_amount', source: 'Net Amt', transforms: [{ op: 'parse_number' }] },
]);

async function newSource(tenantId: string, name: string): Promise<string> {
  return f.db.tenantTx(tenantId, async (tx) => {
    const ds = await tx
      .insertInto('core.data_source')
      .values({
        tenant_id: tenantId,
        name,
        type: 'excel',
        access_mode: 'managed_sync',
        connection: JSON.stringify({ upload_mode: 'manual' }),
        credential_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const d of [customerDoc, invoiceDoc])
      await tx
        .insertInto('core.entity_mapping')
        .values({
          tenant_id: tenantId,
          data_source_id: ds.id,
          source_object: d.source_object,
          canonical_entity: d.canonical_entity,
          status: 'active',
          document: JSON.stringify(d),
          confidence: null,
          created_by: null,
          approved_by: f.A.ownerUserId,
          approved_at: new Date(),
          activated_by: f.A.ownerUserId,
          activated_at: new Date(),
        })
        .execute();
    return ds.id;
  });
}

function service(file: () => Buffer): SyncService {
  const connector = new ExcelConnector();
  const sources = {
    prepare: (tenantId: string, id: string) =>
      Promise.resolve({
        connector,
        dataSourceId: id,
        ctx: {
          tenantId,
          dataSourceId: id,
          config: { upload_mode: 'manual' },
          credentials: undefined,
          deadline: Date.now() + 60_000,
          readUpload: () => Promise.resolve(file()),
        },
      }),
  } as unknown as DataSourceService;
  return new SyncService(f.db, sources, new AuditService());
}

const book = (inv = invoices) =>
  makeXlsx([
    { name: 'Customers', rows: customers },
    { name: 'Invoices', rows: inv },
  ]);

describe('full snapshot sync (E5.1)', () => {
  it('loads rows, resolves references, dead-letters bad rows and records outbox events', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A');
    const result = await service(() => book()).run(f.A.tenantId, id, 'manual');
    expect(result.status).toBe('partially_failed');
    expect(result.objects.Customers).toMatchObject({
      rows_read: 2,
      rows_changed: 2,
      rows_failed: 0,
    });
    expect(result.objects.Invoices).toMatchObject({
      rows_read: 4,
      rows_changed: 3,
      rows_failed: 1,
      unresolved_refs: 1,
    });

    await f.db.tenantTx(f.A.tenantId, async (tx) => {
      const inv = await sql<{ number: string; net_amount: string; customer_id: string | null }>`
        SELECT number, net_amount, customer_id FROM analytics.invoice
         WHERE data_source_id = ${id} ORDER BY number`.execute(tx);
      expect(inv.rows.map((r) => [r.number, r.net_amount, r.customer_id !== null])).toEqual([
        ['INV-1', '11800.00', true],
        ['INV-2', '5900.00', true],
        ['INV-4', '50.00', false], // unknown party: kept with a null reference
      ]);
      const dead = await tx.selectFrom('core.sync_dead_letter').selectAll().execute();
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ field: 'invoice_date', error_code: 'bad_date' });
      expect(JSON.stringify(dead)).not.toContain('not a date'); // no values in dead letters
      const ds = await tx
        .selectFrom('core.dataset')
        .selectAll()
        .orderBy('canonical_entity')
        .execute();
      expect(ds.map((d) => [d.canonical_entity, d.data_version, d.status, d.row_count])).toEqual([
        ['customer', '1', 'fresh', '2'],
        ['invoice', '1', 'fresh', '3'],
      ]);
      const events = await tx.selectFrom('core.outbox_event').select(['type', 'payload']).execute();
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('Asha'); // ids and versions only
    });
  });

  it('is idempotent: a second run changes nothing and does not bump data_version', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A idem');
    const svc = service(() => book());
    await svc.run(f.A.tenantId, id, 'manual');
    const again = await svc.run(f.A.tenantId, id, 'manual');
    expect(again.objects.Customers).toMatchObject({ rows_read: 2, rows_changed: 0 });
    expect(again.objects.Invoices?.rows_changed).toBe(0);
    await f.db.tenantTx(f.A.tenantId, async (tx) => {
      const ds = await tx
        .selectFrom('core.dataset')
        .select(['canonical_entity', 'data_version'])
        .where('data_source_id', '=', id)
        .execute();
      expect(ds.every((d) => d.data_version === '1')).toBe(true);
      const events = await tx
        .selectFrom('core.outbox_event')
        .select('id')
        .where('aggregate_ref', 'like', `dataset:${id}:%`)
        .execute();
      expect(events).toHaveLength(2);
    });
  });

  it('applies a changed row and bumps data_version once', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A change');
    await service(() => book()).run(f.A.tenantId, id, 'manual');
    const changed = invoices.map((r) => [...r]);
    changed[2] = ['INV-2', '2026-04-05', 'C002', 6000];
    const res = await service(() => book(changed)).run(f.A.tenantId, id, 'manual');
    expect(res.objects.Invoices?.rows_changed).toBe(1);
    await f.db.tenantTx(f.A.tenantId, async (tx) => {
      const v = await tx
        .selectFrom('core.dataset')
        .select('data_version')
        .where('data_source_id', '=', id)
        .where('canonical_entity', '=', 'invoice')
        .executeTakeFirstOrThrow();
      expect(v.data_version).toBe('2');
    });
  });

  it('allows one running sync per source', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A lock');
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .insertInto('core.sync_run')
        .values({ tenant_id: f.A.tenantId, data_source_id: id, trigger: 'manual' })
        .execute(),
    );
    await expect(service(() => book()).run(f.A.tenantId, id, 'manual')).rejects.toBeInstanceOf(
      SyncAlreadyRunningError,
    );
  });
});

describe('tenant isolation of sync state (TI-04 and TI-05 for M5)', () => {
  it('tenant B sees none of A sync runs, datasets, checkpoints, dead letters or events', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A iso');
    await service(() => book()).run(f.A.tenantId, id, 'manual');
    await f.db.tenantTx(f.B.tenantId, async (tx) => {
      for (const t of [
        'core.sync_run',
        'core.sync_checkpoint',
        'core.dataset',
        'core.sync_dead_letter',
        'core.outbox_event',
        'analytics.invoice',
        'analytics.customer',
      ] as const)
        expect(await sql`SELECT 1 FROM ${sql.raw(t)}`.execute(tx).then((r) => r.rows)).toEqual([]);
    });
  });

  it('refuses to write a run for another tenant, and cannot resolve another tenant references', async () => {
    const id = await newSource(f.A.tenantId, 'Sync A cross');
    await expect(
      f.db.tenantTx(f.B.tenantId, (tx) =>
        tx
          .insertInto('core.sync_run')
          .values({ tenant_id: f.A.tenantId, data_source_id: id, trigger: 'manual' })
          .execute(),
      ),
    ).rejects.toThrow();
    // Tenant A has customer C001. Tenant B has a source with the same codes but no customers sheet loaded.
    await service(() => book()).run(f.A.tenantId, id, 'manual');
    const bId = await f.db.tenantTx(f.B.tenantId, async (tx) => {
      const ds = await tx
        .insertInto('core.data_source')
        .values({
          tenant_id: f.B.tenantId,
          name: 'B only invoices',
          type: 'excel',
          access_mode: 'managed_sync',
          connection: JSON.stringify({ upload_mode: 'manual' }),
          credential_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('core.entity_mapping')
        .values({
          tenant_id: f.B.tenantId,
          data_source_id: ds.id,
          source_object: 'Invoices',
          canonical_entity: 'invoice',
          status: 'active',
          document: JSON.stringify(invoiceDoc),
          confidence: null,
          created_by: null,
          approved_by: f.B.ownerUserId,
          approved_at: new Date(),
          activated_by: f.B.ownerUserId,
          activated_at: new Date(),
        })
        .execute();
      return ds.id;
    });
    const res = await service(() => book()).run(f.B.tenantId, bId, 'manual');
    // C001 and C002 exist only in tenant A: none may resolve for B.
    expect(res.objects.Invoices?.unresolved_refs).toBe(3);
    await f.db.tenantTx(f.B.tenantId, async (tx) => {
      const r = await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM analytics.invoice WHERE customer_id IS NOT NULL`.execute(
        tx,
      );
      expect(r.rows[0]?.n).toBe('0');
    });
  });
});
