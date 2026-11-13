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
import { MAX_UPLOAD_BYTES } from '../../src/connectors/excel/zip-guard';
import { makeXlsx } from '../fixtures/xlsx';
import { createFixture, type Fixture } from './harness';

// E4.2 and E4.4 (approval part): Excel upload, key selection and human approval of objects.

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

const a = () => ({ token: 'ownerA', tenant: f.A.tenantId });
const b = () => ({ token: 'ownerB', tenant: f.B.tenantId });
const headers = (o: { token: string; tenant: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${o.token}`,
  'x-tenant-id': o.tenant,
  ...extra,
});

const json = (
  path: string,
  o: { token: string; tenant: string; method?: string; body?: unknown },
) =>
  fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: headers(o, { 'content-type': 'application/json' }),
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

const upload = (
  id: string,
  o: { token: string; tenant: string },
  body: Buffer | string,
  contentType = 'application/octet-stream',
  fileName = 'customers.xlsx',
) =>
  fetch(`${base}/v1/data-sources/${id}/upload`, {
    method: 'POST',
    headers: headers(o, { 'content-type': contentType, 'x-file-name': fileName }),
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });

async function newExcelSource(who: { token: string; tenant: string }, name: string) {
  const res = await json('/v1/data-sources', {
    ...who,
    method: 'POST',
    body: { name, type: 'excel', connection: { upload_mode: 'manual' } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const workbook = () =>
  makeXlsx([
    {
      name: 'Customers',
      rows: [
        ['Customer ID', 'Name', 'City'],
        [101, 'Asha Traders', 'Pune'],
        [102, 'Vikram Stores', 'Pune'],
        [103, 'Mehta & Sons', null],
      ],
    },
  ]);

describe('Excel upload flow (E4.2)', () => {
  it('creates an upload source without credentials, then tests, uploads and discovers', async () => {
    const id = await newExcelSource(a(), 'Customer sheet');
    const created = await (await json(`/v1/data-sources/${id}`, a())).json();
    expect(created).toMatchObject({ type: 'excel', has_credentials: false, status: 'draft' });

    // Nothing uploaded yet.
    const before = await json(`/v1/data-sources/${id}/test`, { ...a(), method: 'POST' });
    expect(await before.json()).toMatchObject({ ok: false, errors: ['no file has been uploaded'] });
    expect(
      (await json(`/v1/data-sources/${id}/discover-schema`, { ...a(), method: 'POST' })).status,
    ).toBe(422);

    const up = await upload(id, a(), workbook());
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ size_bytes: workbook().length });

    const test = await json(`/v1/data-sources/${id}/test`, { ...a(), method: 'POST' });
    expect(await test.json()).toEqual({ ok: true, errors: [], privilege_warnings: [] });

    const schema = (await (
      await json(`/v1/data-sources/${id}/discover-schema`, { ...a(), method: 'POST' })
    ).json()) as { objects: { name: string; key_candidates: string[] }[]; fingerprint: string };
    expect(schema.objects.map((o) => o.name)).toEqual(['Customers']);
    expect(schema.objects[0]?.key_candidates).toEqual(['Customer ID', 'Name']);
  });

  it('a newer upload replaces the older one for discovery', async () => {
    const id = await newExcelSource(a(), 'Versioned');
    await upload(id, a(), makeXlsx([{ name: 'Old', rows: [['id'], [1]] }]));
    await upload(id, a(), makeXlsx([{ name: 'New', rows: [['id'], [1]] }]));
    const schema = (await (
      await json(`/v1/data-sources/${id}/discover-schema`, { ...a(), method: 'POST' })
    ).json()) as { objects: { name: string }[] };
    expect(schema.objects.map((o) => o.name)).toEqual(['New']);
  });

  it('rejects bad uploads without storing them', async () => {
    const id = await newExcelSource(a(), 'Bad uploads');
    expect((await upload(id, a(), 'id,name\n1,a\n')).status).toBe(422); // csv text
    expect((await upload(id, a(), workbook(), 'text/plain')).status).toBe(415);
    // The framework's JSON parser rejects binary data sent as JSON before the route runs.
    expect((await upload(id, a(), workbook(), 'application/json')).status).toBe(400);
    expect((await upload(id, a(), Buffer.alloc(0))).status).toBe(400);
    const bomb = makeXlsx([{ name: 'S', rows: [['id'], [1]] }], {
      declaredSize: 4 * 1024 * 1024 * 1024 - 2,
    });
    expect((await upload(id, a(), bomb)).status).toBe(422);
    const big = Buffer.concat([workbook(), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect((await upload(id, a(), big)).status).toBe(413);
    const stored = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_upload')
        .select('id')
        .where('data_source_id', '=', id)
        .execute(),
    );
    expect(stored).toHaveLength(0);
  });

  it('does not accept uploads for a database source', async () => {
    const res = await json('/v1/data-sources', {
      ...a(),
      method: 'POST',
      body: {
        name: 'A database',
        type: 'postgresql',
        connection: { host: 'db.example.com', port: 5432, database: 'x' },
        credentials: { username: 'u', password: 'p' },
      },
    });
    const id = ((await res.json()) as { id: string }).id;
    expect((await upload(id, a(), workbook())).status).toBe(409);
  });

  it('keeps file names out of the object key and the audit log', async () => {
    const id = await newExcelSource(a(), 'Naming');
    await upload(
      id,
      a(),
      workbook(),
      'application/octet-stream',
      '../../etc/Q3 payroll (final).xlsx',
    );
    const [row] = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_upload')
        .select(['object_key', 'file_name'])
        .where('data_source_id', '=', id)
        .execute(),
    );
    expect(row?.file_name).toBe('Q3 payroll (final).xlsx');
    expect(row?.object_key).toMatch(new RegExp(`^uploads/${id}/[0-9a-f-]{36}\\.xlsx$`));
    const audit = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select('metadata')
        .where('action', '=', 'data_source.file_uploaded')
        .where('target', '=', id)
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('payroll');
    expect(JSON.stringify(audit)).not.toContain('Asha');
  });

  it('isolates tenants: B cannot upload to, discover, key or approve an A source', async () => {
    const id = await newExcelSource(a(), 'Tenant A only');
    await upload(id, a(), workbook());
    expect((await upload(id, b(), workbook())).status).toBe(404);
    expect(
      (await json(`/v1/data-sources/${id}/discover-schema`, { ...b(), method: 'POST' })).status,
    ).toBe(404);
    expect(
      (
        await json(`/v1/data-sources/${id}/objects/Customers`, {
          ...b(),
          method: 'PUT',
          body: { key_columns: ['Customer ID'] },
        })
      ).status,
    ).toBe(404);
    expect(
      (await json(`/v1/data-sources/${id}/objects/Customers/approve`, { ...b(), method: 'POST' }))
        .status,
    ).toBe(409);
    expect(await (await json(`/v1/data-sources/${id}/objects`, b())).json()).toEqual([]);
    // B's own source with the same sheet and file name sees only B's file.
    const bid = await newExcelSource(b(), 'Tenant B');
    await upload(bid, b(), makeXlsx([{ name: 'OnlyB', rows: [['id'], [1]] }]));
    const schema = (await (
      await json(`/v1/data-sources/${bid}/discover-schema`, { ...b(), method: 'POST' })
    ).json()) as { objects: { name: string }[] };
    expect(schema.objects.map((o) => o.name)).toEqual(['OnlyB']);
  });

  it('requires permissions', async () => {
    const id = await newExcelSource(a(), 'Perms');
    const viewer = { token: 'viewerA', tenant: f.A.tenantId };
    expect((await upload(id, viewer, workbook())).status).toBe(403);
    expect(
      (
        await json(`/v1/data-sources/${id}/objects/Customers`, {
          ...viewer,
          method: 'PUT',
          body: { key_columns: ['Customer ID'] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await json(`/v1/data-sources/${id}/objects/Customers/approve`, {
          ...viewer,
          method: 'POST',
        })
      ).status,
    ).toBe(403);
  });
});

describe('key selection and human approval (D-10)', () => {
  const put = (id: string, name: string, columns: string[]) =>
    json(`/v1/data-sources/${id}/objects/${encodeURIComponent(name)}`, {
      ...a(),
      method: 'PUT',
      body: { key_columns: columns },
    });
  const approve = (id: string, name: string) =>
    json(`/v1/data-sources/${id}/objects/${encodeURIComponent(name)}/approve`, {
      ...a(),
      method: 'POST',
    });

  it('selects a unique key, approves it, and withdraws approval when the key changes', async () => {
    const id = await newExcelSource(a(), 'Approval');
    await upload(id, a(), workbook());

    expect((await approve(id, 'Customers')).status).toBe(409); // no keys yet
    expect((await put(id, 'Customers', ['City'])).status).toBe(422); // not unique, has a gap
    expect((await put(id, 'Customers', ['Customer ID', 'Name'])).status).toBe(422); // single column only
    expect((await put(id, 'Customers', ['Missing'])).status).toBe(400);
    expect((await put(id, 'Nope', ['Customer ID'])).status).toBe(404);

    expect(await (await put(id, 'Customers', ['Customer ID'])).json()).toEqual({
      name: 'Customers',
      key_columns: ['Customer ID'],
      approved: false,
    });
    expect(await (await approve(id, 'Customers')).json()).toEqual({
      name: 'Customers',
      approved: true,
    });
    const listed = (await (await json(`/v1/data-sources/${id}/objects`, a())).json()) as {
      name: string;
      approved: boolean;
    }[];
    expect(listed).toMatchObject([{ name: 'Customers', approved: true }]);

    // Changing the key withdraws the approval.
    await put(id, 'Customers', ['Name']);
    const after = (await (await json(`/v1/data-sources/${id}/objects`, a())).json()) as {
      approved: boolean;
    }[];
    expect(after[0]?.approved).toBe(false);
  });

  it('re-checks the key at approval time, because the file may have changed', async () => {
    const id = await newExcelSource(a(), 'Drift at approval');
    await upload(id, a(), workbook());
    await put(id, 'Customers', ['Customer ID']);
    // A new upload makes the chosen key non-unique.
    await upload(
      id,
      a(),
      makeXlsx([
        {
          name: 'Customers',
          rows: [
            ['Customer ID', 'Name'],
            [1, 'a'],
            [1, 'b'],
          ],
        },
      ]),
    );
    expect((await approve(id, 'Customers')).status).toBe(422);
  });

  it('records selections and approvals in the audit log with identifiers only', async () => {
    const id = await newExcelSource(a(), 'Audit');
    await upload(id, a(), workbook());
    await put(id, 'Customers', ['Customer ID']);
    await approve(id, 'Customers');
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'metadata'])
        .where('target', '=', id)
        .execute(),
    );
    expect(events.map((e) => e.action).sort()).toEqual(
      [
        'data_source.created',
        'data_source.file_uploaded',
        'data_source.keys_selected',
        'data_source.object_approved',
      ].sort(),
    );
    expect(JSON.stringify(events)).not.toContain('Asha');
  });
});

describe('TI-04 catalog covers the upload tables', () => {
  it('has forced RLS and a tenant policy on data_source_upload and data_source_object', async () => {
    const rows = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'core' AND c.relname IN ('data_source_upload', 'data_source_object')`.execute(
      f.owner,
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });
});
