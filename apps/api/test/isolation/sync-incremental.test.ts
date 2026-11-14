import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { DataSourceService } from '../../src/connectors/data-source.service';
import { ExcelConnector } from '../../src/connectors/excel/excel.connector';
import { PostgresConnector } from '../../src/connectors/postgresql/postgresql.connector';
import type { Connector } from '../../src/connectors/connector';
import type { MappingDocument } from '../../src/mapping/mapping-document';
import { SyncService } from '../../src/sync/sync.service';
import { makeXlsx } from '../fixtures/xlsx';
import { createFixture, env, type Fixture } from './harness';

// E5.2 (timestamp cursor), E5.3 (delete propagation and schema drift) against a real PostgreSQL
// that is both the application database and the customer's source database.

let f: Fixture;
const run = randomUUID().slice(0, 8);
const schema = `m5_src_${run}`;
const role = `m5_reader_${run}`;
const password = `Rd-${randomBytes(12).toString('hex')}`;

async function admin(text: string): Promise<void> {
  const e = env();
  const client = new Client({
    host: e.POSTGRES_HOST,
    port: e.POSTGRES_PORT,
    database: e.POSTGRES_DB,
    user: 'postgres',
    password: process.env.POSTGRES_ADMIN_PASSWORD ?? e.POSTGRES_OWNER_PASSWORD,
  });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  f = await createFixture();
  await admin(`CREATE SCHEMA ${schema}`);
  await admin(
    `CREATE TABLE ${schema}.parties (id integer PRIMARY KEY, name text NOT NULL, city text, updated_at timestamptz NOT NULL DEFAULT now())`,
  );
  await admin(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin(`GRANT CONNECT ON DATABASE ${env().POSTGRES_DB} TO ${role}`);
  await admin(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin(`GRANT SELECT ON ${schema}.parties TO ${role}`);
});
afterAll(async () => {
  await admin(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
  await admin(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await f.close();
});

const partyDoc: MappingDocument = {
  template: 'wholesale_distribution@0',
  canonical_entity: 'customer',
  source_object: 'parties',
  key_fields: ['id'],
  updated_at_field: 'updated_at',
  field_mappings: [
    { target: 'code', source: 'id', transforms: [{ op: 'cast', args: { to: 'text' } }] },
    { target: 'name', source: 'name' },
    { target: 'city', source: 'city' },
  ],
  status: 'active',
};

async function newSource(type: 'postgresql' | 'excel', docs: MappingDocument[]): Promise<string> {
  const tenantId = f.A.tenantId;
  return f.db.tenantTx(tenantId, async (tx) => {
    const ds = await tx
      .insertInto('core.data_source')
      .values({
        tenant_id: tenantId,
        name: `inc ${randomUUID().slice(0, 6)}`,
        type,
        access_mode: 'managed_sync',
        connection: JSON.stringify({}),
        credential_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const d of docs)
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

function service(
  connector: Connector,
  ctxExtra: Record<string, unknown>,
  creds?: unknown,
): SyncService {
  const sources = {
    prepare: (tenantId: string, id: string) =>
      Promise.resolve({
        connector,
        dataSourceId: id,
        ctx: {
          tenantId,
          dataSourceId: id,
          credentials: creds,
          deadline: Date.now() + 60_000,
          ...ctxExtra,
        },
      }),
  } as unknown as DataSourceService;
  return new SyncService(f.db, sources, new AuditService());
}

const pg = () =>
  service(
    new PostgresConnector({ allowPrivateNetworks: true }),
    {
      config: {
        host: env().POSTGRES_HOST === 'localhost' ? '127.0.0.1' : env().POSTGRES_HOST,
        port: env().POSTGRES_PORT,
        database: env().POSTGRES_DB,
        schema,
        tls_mode: 'disable',
      },
    },
    { username: role, password },
  );

const live = (id: string) =>
  f.db.tenantTx(f.A.tenantId, async (tx) => {
    const r = await sql<{ name: string }>`SELECT name FROM analytics.customer
      WHERE data_source_id = ${id} AND deleted_at IS NULL ORDER BY name`.execute(tx);
    return r.rows.map((x) => x.name);
  });
const version = (id: string) =>
  f.db.tenantTx(
    f.A.tenantId,
    async (tx) =>
      (
        await tx
          .selectFrom('core.dataset')
          .select('data_version')
          .where('data_source_id', '=', id)
          .executeTakeFirstOrThrow()
      ).data_version,
  );

describe('PostgreSQL incremental sync and deletes (E5.2, E5.3)', () => {
  it('reads everything first, then only changed rows, then propagates a delete', async () => {
    await admin(`INSERT INTO ${schema}.parties (id, name, city, updated_at) VALUES
      (1,'Asha','Pune', now() - interval '3 hours'),(2,'Vikram','Nashik', now() - interval '3 hours'),
      (3,'Meena','Surat', now() - interval '3 hours')`);
    const id = await newSource('postgresql', [partyDoc]);

    const first = await pg().run(f.A.tenantId, id, 'manual');
    expect(first.objects.parties).toMatchObject({ mode: 'full', rows_read: 3, rows_changed: 3 });
    expect(await live(id)).toEqual(['Asha', 'Meena', 'Vikram']);

    // Nothing changed: an incremental run re-reads at most the boundary row and changes nothing.
    const quiet = await pg().run(f.A.tenantId, id, 'manual');
    expect(quiet.objects.parties).toMatchObject({ mode: 'incremental', rows_changed: 0 });
    expect(quiet.objects.parties?.rows_read).toBeLessThanOrEqual(3);

    // A new row and an edited row. Rows sharing the cursor timestamp are read again but not changed.
    await admin(`INSERT INTO ${schema}.parties (id, name, city) VALUES (4,'Nikhil','Delhi')`);
    await admin(`UPDATE ${schema}.parties SET city = 'Mumbai', updated_at = now() WHERE id = 2`);
    const inc = await pg().run(f.A.tenantId, id, 'manual');
    expect(inc.objects.parties).toMatchObject({
      mode: 'incremental',
      rows_read: 4,
      rows_changed: 2,
    });
    expect(await live(id)).toEqual(['Asha', 'Meena', 'Nikhil', 'Vikram']);
    expect(await version(id)).toBe('2');

    // A hard delete is invisible to a timestamp cursor. It is found by the next reconciliation,
    // which an incremental run performs once the last one is old: age the checkpoint to force it.
    await admin(`DELETE FROM ${schema}.parties WHERE id = 3`);
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      sql`UPDATE core.sync_checkpoint SET cursor = jsonb_set(cursor, '{reconciled_at}', '"2020-01-01T00:00:00.000Z"')
          WHERE data_source_id = ${id}`.execute(tx),
    );
    const del = await pg().run(f.A.tenantId, id, 'manual');
    expect(del.objects.parties).toMatchObject({ mode: 'incremental', rows_deleted: 1 });
    expect(await live(id)).toEqual(['Asha', 'Nikhil', 'Vikram']);
    expect(await version(id)).toBe('3');
  });

  it('pauses the object and asks for re-approval when a mapped column disappears', async () => {
    const id = await newSource('postgresql', [{ ...partyDoc, updated_at_field: undefined }]);
    await pg().run(f.A.tenantId, id, 'manual');
    await admin(`ALTER TABLE ${schema}.parties RENAME COLUMN city TO town`);
    try {
      const res = await pg().run(f.A.tenantId, id, 'manual');
      expect(res.status).toBe('paused');
      expect(res.objects.parties?.paused).toEqual(['column_missing:city']);
      await f.db.tenantTx(f.A.tenantId, async (tx) => {
        const m = await tx
          .selectFrom('core.entity_mapping')
          .select('status')
          .where('data_source_id', '=', id)
          .executeTakeFirstOrThrow();
        expect(m.status).toBe('needs_review');
        const d = await tx
          .selectFrom('core.dataset')
          .select('status')
          .where('data_source_id', '=', id)
          .executeTakeFirstOrThrow();
        expect(d.status).toBe('paused');
        const audit = await tx
          .selectFrom('core.audit_event')
          .select('action')
          .where('target', '=', id)
          .execute();
        expect(audit.map((a) => a.action)).toContain('sync.paused_schema_drift');
      });
      // The paused mapping is no longer active: nothing syncs until a person approves a new one.
      await expect(pg().run(f.A.tenantId, id, 'manual')).rejects.toThrow('no active mapping');
    } finally {
      await admin(`ALTER TABLE ${schema}.parties RENAME COLUMN town TO city`);
    }
  });
});

describe('Excel deletes and the safety guards (E5.3)', () => {
  const doc: MappingDocument = {
    ...partyDoc,
    source_object: 'Parties',
    key_fields: ['Code'],
    updated_at_field: undefined,
    field_mappings: [
      { target: 'code', source: 'Code' },
      { target: 'name', source: 'Name' },
    ],
  };
  const excel = (rows: string[][]) =>
    service(new ExcelConnector(), {
      config: { upload_mode: 'manual' },
      readUpload: () =>
        Promise.resolve(makeXlsx([{ name: 'Parties', rows: [['Code', 'Name'], ...rows] }])),
    });

  it('marks rows missing from the file as deleted and revives them when they return', async () => {
    const id = await newSource('excel', [doc]);
    await excel([
      ['A', 'Asha'],
      ['B', 'Bimal'],
      ['C', 'Chitra'],
    ]).run(f.A.tenantId, id, 'upload');
    const res = await excel([
      ['A', 'Asha'],
      ['C', 'Chitra'],
    ]).run(f.A.tenantId, id, 'upload');
    expect(res.objects.Parties).toMatchObject({ rows_deleted: 1, rows_changed: 0 });
    expect(await live(id)).toEqual(['Asha', 'Chitra']);
    const back = await excel([
      ['A', 'Asha'],
      ['B', 'Bimal'],
      ['C', 'Chitra'],
    ]).run(f.A.tenantId, id, 'upload');
    expect(back.objects.Parties?.rows_changed).toBe(1);
    expect(await live(id)).toEqual(['Asha', 'Bimal', 'Chitra']);
  });

  it('refuses to delete everything when the source suddenly has no rows', async () => {
    const id = await newSource('excel', [doc]);
    await excel([['A', 'Asha']]).run(f.A.tenantId, id, 'upload');
    const res = await excel([]).run(f.A.tenantId, id, 'upload');
    expect(res.objects.Parties?.error_code).toBe('source_empty');
    expect(await live(id)).toEqual(['Asha']);
  });

  it('does not delete when two objects feed the same entity', async () => {
    const id = await newSource('excel', [doc, { ...doc, source_object: 'Parties2' }]);
    const two = (rows: string[][]) =>
      service(new ExcelConnector(), {
        config: { upload_mode: 'manual' },
        readUpload: () =>
          Promise.resolve(
            makeXlsx([
              { name: 'Parties', rows: [['Code', 'Name'], ...rows] },
              {
                name: 'Parties2',
                rows: [
                  ['Code', 'Name'],
                  ['Z', 'Zed'],
                ],
              },
            ]),
          ),
      });
    await two([['A', 'Asha']]).run(f.A.tenantId, id, 'upload');
    const res = await two([]).run(f.A.tenantId, id, 'upload');
    expect(res.objects.Parties?.rows_deleted).toBe(0);
    expect(await live(id)).toEqual(['Asha', 'Zed']);
  });
});
