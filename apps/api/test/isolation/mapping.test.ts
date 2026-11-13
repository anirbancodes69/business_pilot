import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier, UnauthenticatedError } from '../../src/identity/token-verifier';
import { requestIdMiddleware } from '../../src/platform/request-id/request-id';
import { ENTITIES } from '../../src/mapping/canonical-catalog';
import { makeXlsx } from '../fixtures/xlsx';
import { createFixture, type Fixture } from './harness';

// Milestone 4 acceptance (ROADMAP): a user uploads an Excel file, sees the discovered schema, reviews
// suggested mappings and approves them. Credentials are never returned or logged.

let f: Fixture;
let app: INestApplication;
let base = '';

beforeAll(async () => {
  f = await createFixture();
  process.env.LOCAL_KEK_BASE64 ??= randomBytes(32).toString('base64');
  const verifier: TokenVerifier = {
    verify: async (t) => {
      const subject = f.subjects[t];
      if (!subject) throw new UnauthenticatedError('bad token');
      return { subject, email: null, name: null };
    },
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TokenVerifier)
    .useValue(verifier)
    .compile();
  app = mod.createNestApplication();
  app.use(requestIdMiddleware);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await f.close();
});

type Who = { token: string; tenant: string };
const a = (): Who => ({ token: 'ownerA', tenant: f.A.tenantId });
const b = (): Who => ({ token: 'ownerB', tenant: f.B.tenantId });
const viewer = (): Who => ({ token: 'viewerA', tenant: f.A.tenantId });

const api = (path: string, o: Who & { method?: string; body?: unknown }) =>
  fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: {
      authorization: `Bearer ${o.token}`,
      'x-tenant-id': o.tenant,
      'content-type': 'application/json',
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
const post = (path: string, who: Who, body?: unknown) =>
  api(path, { ...who, method: 'POST', body });

async function upload(id: string, who: Who, file: Buffer) {
  return fetch(`${base}/v1/data-sources/${id}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${who.token}`,
      'x-tenant-id': who.tenant,
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(file),
  });
}

const customers = [
  ['Party Code', 'Party Name', 'GSTIN', 'City', 'Credit Limit'],
  ['C001', 'Asha Traders', '27ABCDE1234F1Z5', 'Pune', 50000],
  ['C002', 'Vikram Stores', '27PQRST5678G1Z2', 'Nashik', 25000],
];
const invoices = [
  ['Inv No', 'Inv Date', 'Party Code', 'Net Amt'],
  ['INV-1', '2026-04-02', 'C001', 11800],
  ['INV-2', '2026-04-05', 'C002', 5900],
];

/** A source with two approved sheets, ready for mapping. */
async function readySource(who: Who, name: string) {
  const res = await post('/v1/data-sources', who, {
    name,
    type: 'excel',
    connection: { upload_mode: 'manual' },
  });
  const { id } = (await res.json()) as { id: string };
  await upload(
    id,
    who,
    makeXlsx([
      { name: 'Customer Master', rows: customers },
      { name: 'Sales Invoices', rows: invoices },
      { name: 'Random notes', rows: [['Foo'], ['x'], ['y']] },
    ]),
  );
  for (const [object, key] of [
    ['Customer Master', 'Party Code'],
    ['Sales Invoices', 'Inv No'],
    ['Random notes', 'Foo'],
  ] as const) {
    const put = await api(`/v1/data-sources/${id}/objects/${encodeURIComponent(object)}`, {
      ...who,
      method: 'PUT',
      body: { key_columns: [key] },
    });
    expect(put.status).toBe(200);
    expect(
      (await post(`/v1/data-sources/${id}/objects/${encodeURIComponent(object)}/approve`, who))
        .status,
    ).toBe(200);
  }
  return id;
}

type Suggested = {
  object: string;
  mapping_id?: string;
  entity?: string;
  confidence: number;
}[];

describe('Milestone 4 acceptance: upload, discover, suggest, review, approve, activate', () => {
  it('runs the whole flow', async () => {
    const id = await readySource(a(), 'Acceptance');
    const mappings = `/v1/data-sources/${id}/mappings`;

    // Suggest
    const res = await post(`${mappings}/suggest`, a());
    expect(res.status).toBe(200);
    const suggested = (await res.json()) as Suggested;
    const byObject = Object.fromEntries(suggested.map((s) => [s.object, s]));
    expect(byObject['Customer Master']?.entity).toBe('customer');
    expect(byObject['Sales Invoices']?.entity).toBe('invoice');
    expect(byObject['Random notes']?.mapping_id).toBeUndefined(); // nothing fits: no suggestion
    const customerId = byObject['Customer Master']?.mapping_id as string;
    const invoiceId = byObject['Sales Invoices']?.mapping_id as string;

    // Nothing leaks into the stored documents: names and types only, no cell values.
    const listText = await (await api(mappings, a())).text();
    const docText = await (await api(`${mappings}/${customerId}`, a())).text();
    for (const secret of ['Asha Traders', 'C001', '27ABCDE1234F1Z5', 'INV-1', '2026-04-02'])
      expect(listText + docText).not.toContain(secret);

    const doc = (await (await api(`${mappings}/${customerId}`, a())).json()) as {
      status: string;
      document: {
        key_fields: string[];
        suggestion_method: string;
        field_mappings: { target: string; source: string; tags?: string[]; confidence: number }[];
      };
    };
    expect(doc.status).toBe('suggested');
    expect(doc.document.key_fields).toEqual(['Party Code']);
    expect(doc.document.suggestion_method).toBe('heuristic');
    const gstin = doc.document.field_mappings.find((m) => m.target === 'gstin');
    expect(gstin).toMatchObject({ source: 'GSTIN', tags: ['pii'] });

    // A suggestion cannot be approved or activated without a review.
    expect((await post(`${mappings}/${customerId}/approve`, a())).status).toBe(409);
    expect((await post(`${mappings}/${customerId}/activate`, a())).status).toBe(409);

    // Review, approve, activate: customers
    expect((await post(`${mappings}/${customerId}/review`, a())).status).toBe(200);
    expect(await (await post(`${mappings}/${customerId}/approve`, a())).json()).toEqual({
      id: customerId,
      status: 'approved',
    });
    expect((await post(`${mappings}/${customerId}/activate`, a())).status).toBe(200);

    // Invoices: edit first (drop the amount), which must block approval until it is restored.
    const inv = (await (await api(`${mappings}/${invoiceId}`, a())).json()) as {
      document: { field_mappings: { target: string }[] };
    };
    const without = {
      ...inv.document,
      field_mappings: inv.document.field_mappings.filter((m) => m.target !== 'net_amount'),
    };
    expect(
      (await api(`${mappings}/${invoiceId}`, { ...a(), method: 'PUT', body: without })).status,
    ).toBe(200);
    const blocked = await post(`${mappings}/${invoiceId}/approve`, a());
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(await blocked.json())).toContain('net_amount: required');
    expect(
      (await api(`${mappings}/${invoiceId}`, { ...a(), method: 'PUT', body: inv.document })).status,
    ).toBe(200);
    expect((await post(`${mappings}/${invoiceId}/approve`, a())).status).toBe(200);
    expect((await post(`${mappings}/${invoiceId}/activate`, a())).status).toBe(200);

    const final = (await (await api(mappings, a())).json()) as {
      source_object: string;
      status: string;
    }[];
    expect(
      final
        .filter((m) => m.status === 'active')
        .map((m) => m.source_object)
        .sort(),
    ).toEqual(['Customer Master', 'Sales Invoices']);

    // Audit trail covers every step, with identifiers only.
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'metadata'])
        .where('action', 'like', 'mapping.%')
        .execute(),
    );
    const actions = new Set(events.map((e) => e.action));
    for (const x of ['suggested', 'reviewed', 'edited', 'approved', 'activated'])
      expect(actions.has(`mapping.${x}`), x).toBe(true);
    for (const secret of ['Asha', 'C001', '27ABCDE', 'INV-1'])
      expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('a new suggestion supersedes unreviewed drafts but not active mappings; a new activation supersedes the old one', async () => {
    const id = await readySource(a(), 'Resuggest');
    const mappings = `/v1/data-sources/${id}/mappings`;
    const first = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const firstId = first[0]?.mapping_id as string;
    await post(`${mappings}/${firstId}/review`, a());
    await post(`${mappings}/${firstId}/approve`, a());
    await post(`${mappings}/${firstId}/activate`, a());

    const second = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const secondId = second[0]?.mapping_id as string;
    const third = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const thirdId = third[0]?.mapping_id as string;
    const statusOf = async (mid: string) =>
      ((await (await api(`${mappings}/${mid}`, a())).json()) as { status: string }).status;
    expect(await statusOf(firstId)).toBe('active'); // untouched by suggestions
    expect(await statusOf(secondId)).toBe('superseded');
    expect(await statusOf(thirdId)).toBe('suggested');

    await post(`${mappings}/${thirdId}/review`, a());
    await post(`${mappings}/${thirdId}/approve`, a());
    await post(`${mappings}/${thirdId}/activate`, a());
    expect(await statusOf(firstId)).toBe('superseded');
    expect(await statusOf(thirdId)).toBe('active');
    // A superseded or active mapping cannot be edited or rejected.
    expect((await post(`${mappings}/${firstId}/reject`, a())).status).toBe(409);
    expect((await api(`${mappings}/${firstId}`, { ...a(), method: 'PUT', body: {} })).status).toBe(
      409,
    );
  });

  it('rejects invalid edits without echoing values', async () => {
    const id = await readySource(a(), 'Bad edits');
    const mappings = `/v1/data-sources/${id}/mappings`;
    const s = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const mid = s[0]?.mapping_id as string;
    const cur = (await (await api(`${mappings}/${mid}`, a())).json()) as {
      document: { field_mappings: Record<string, unknown>[]; key_fields: string[] };
    };
    const put = (doc: unknown) => api(`${mappings}/${mid}`, { ...a(), method: 'PUT', body: doc });
    const doc = cur.document;
    const fm = doc.field_mappings;

    expect((await put({ ...doc, canonical_entity: 'spaceship' })).status).toBe(400);
    expect((await put({ ...doc, key_fields: ['City'] })).status).toBe(400); // not the approved key
    expect((await put({ ...doc, row_filter: "city = 'Pune'" })).status).toBe(400); // grammar undecided
    expect(
      (await put({ ...doc, field_mappings: [...fm, { target: 'name', source: 'City' }] })).status,
    ).toBe(400); // mapped twice
    expect(
      (await put({ ...doc, field_mappings: [{ target: 'name', source: 'No such column' }] }))
        .status,
    ).toBe(400);
    expect(
      (await put({ ...doc, field_mappings: [{ target: 'nonsense', source: 'City' }] })).status,
    ).toBe(400);
    expect(
      (await put({ ...doc, field_mappings: [{ target: 'name', source: 'City', constant: 'x' }] }))
        .status,
    ).toBe(400);
    expect((await put({ ...doc, extra_field: 1 })).status).toBe(400);
    // A reference without lookup_ref is refused.
    const inv = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Sales Invoices'] })
    ).json()) as Suggested;
    const invDoc = (await (await api(`${mappings}/${inv[0]?.mapping_id}`, a())).json()) as {
      document: { field_mappings: { target: string; source: string }[] };
    };
    const bad = await api(`${mappings}/${inv[0]?.mapping_id}`, {
      ...a(),
      method: 'PUT',
      body: {
        ...invDoc.document,
        field_mappings: invDoc.document.field_mappings.map((m) =>
          m.target === 'customer_id' ? { target: 'customer_id', source: m.source } : m,
        ),
      },
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).not.toContain('C001');
    // A valid edit may add a tenant-specific attribute, and the catalog tags are kept.
    const ok = await put({
      ...doc,
      field_mappings: [
        ...fm.filter((m) => m.target !== 'gstin'),
        { target: 'gstin', source: 'GSTIN', tags: [] },
        { target: 'ext.region_code', source: 'City' },
      ],
    });
    expect(ok.status).toBe(200);
    const after = (await (await api(`${mappings}/${mid}`, a())).json()) as {
      document: {
        suggestion_method: string;
        field_mappings: { target: string; tags?: string[] }[];
      };
    };
    expect(after.document.field_mappings.find((m) => m.target === 'gstin')?.tags).toEqual(['pii']);
    expect(after.document.suggestion_method).toBe('manual');
  });

  it('cannot suggest for objects that are not approved', async () => {
    const res = await post('/v1/data-sources', a(), {
      name: 'Unapproved',
      type: 'excel',
      connection: { upload_mode: 'manual' },
    });
    const { id } = (await res.json()) as { id: string };
    await upload(id, a(), makeXlsx([{ name: 'Customers', rows: customers }]));
    const mappings = `/v1/data-sources/${id}/mappings`;
    expect((await post(`${mappings}/suggest`, a())).status).toBe(409); // none approved
    expect((await post(`${mappings}/suggest`, a(), { objects: ['Customers'] })).status).toBe(409);
  });

  it('is permission-checked: managers suggest, only approvers approve and activate', async () => {
    const id = await readySource(a(), 'Perms');
    const mappings = `/v1/data-sources/${id}/mappings`;
    expect((await post(`${mappings}/suggest`, viewer())).status).toBe(403);
    expect((await api(mappings, viewer())).status).toBe(403);
    const s = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const mid = s[0]?.mapping_id as string;
    for (const action of ['review', 'reject', 'approve', 'activate'])
      expect((await post(`${mappings}/${mid}/${action}`, viewer())).status, action).toBe(403);
  });

  it('isolates tenants: B cannot see, suggest, edit, approve or activate A mappings', async () => {
    const id = await readySource(a(), 'Isolated');
    const mappings = `/v1/data-sources/${id}/mappings`;
    const s = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const mid = s[0]?.mapping_id as string;

    expect(await (await api(mappings, b())).json()).toEqual([]);
    expect((await api(`${mappings}/${mid}`, b())).status).toBe(404);
    expect((await post(`${mappings}/suggest`, b())).status).toBe(409); // sees no approved objects
    for (const action of ['review', 'reject', 'approve', 'activate'])
      expect((await post(`${mappings}/${mid}/${action}`, b())).status, action).toBe(404);
    expect((await api(`${mappings}/${mid}`, { ...b(), method: 'PUT', body: {} })).status).toBe(404);
    // Direct database check: B's context sees none of A's rows.
    const rows = await f.db.tenantTx(f.B.tenantId, (tx) =>
      tx.selectFrom('core.entity_mapping').select('id').execute(),
    );
    expect(rows.map((r) => r.id)).not.toContain(mid);
  });

  it('keeps one active mapping per object at the database level', async () => {
    const id = await readySource(a(), 'One active');
    const mappings = `/v1/data-sources/${id}/mappings`;
    const s = (await (
      await post(`${mappings}/suggest`, a(), { objects: ['Customer Master'] })
    ).json()) as Suggested;
    const mid = s[0]?.mapping_id as string;
    await post(`${mappings}/${mid}/review`, a());
    await post(`${mappings}/${mid}/approve`, a());
    await post(`${mappings}/${mid}/activate`, a());
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        tx
          .insertInto('core.entity_mapping')
          .values({
            tenant_id: f.A.tenantId,
            data_source_id: id,
            source_object: 'Customer Master',
            canonical_entity: 'customer',
            status: 'active',
            document: '{}',
            approved_by: f.A.ownerUserId,
            approved_at: new Date(),
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

describe('canonical catalog matches the analytics tables', () => {
  const standard = new Set([
    'tenant_id',
    'id',
    'data_source_id',
    'source_key',
    'content_hash',
    'ext',
    'synced_at',
    'deleted_at',
  ]);
  const dbType = {
    text: 'text',
    integer: 'integer',
    numeric: 'numeric',
    date: 'date',
    ref: 'uuid',
  };

  it('has the same entities, attributes and types as migration 0004', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'analytics'`.execute(f.owner);
    const columns = new Map<string, Map<string, string>>();
    for (const r of rows.rows) {
      if (standard.has(r.column_name)) continue;
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Map());
      columns.get(r.table_name)?.set(r.column_name, r.data_type);
    }
    expect([...columns.keys()].sort()).toEqual(ENTITIES.map((e) => e.name).sort());
    for (const entity of ENTITIES) {
      const actual = columns.get(entity.name) as Map<string, string>;
      expect([...actual.keys()].sort(), entity.name).toEqual(
        entity.attributes.map((x) => x.name).sort(),
      );
      for (const attr of entity.attributes) {
        const type = actual.get(attr.name);
        if (attr.type === 'text')
          expect(['text', 'character'], `${entity.name}.${attr.name}`).toContain(type);
        else expect(type, `${entity.name}.${attr.name}`).toBe(dbType[attr.type]);
      }
    }
  });
});

describe('TI-04 catalog covers entity_mapping', () => {
  it('has forced RLS', async () => {
    const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'core' AND c.relname = 'entity_mapping'`.execute(f.owner);
    expect(rows.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
});
