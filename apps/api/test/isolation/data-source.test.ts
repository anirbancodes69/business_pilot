import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier, UnauthenticatedError } from '../../src/identity/token-verifier';
import { requestIdMiddleware } from '../../src/platform/request-id/request-id';
import { createFixture, env, type Fixture } from './harness';

// E4.1 and E4.3: data sources, encrypted credentials and the PostgreSQL connector, against a real
// PostgreSQL that plays both the application database and the customer's source database.

let f: Fixture;
// The "customer database" fixtures need DDL and roles, which the application roles must not have.
// The bootstrap administrator (compose: user postgres) is used for test fixtures only.
async function admin<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
): Promise<T[]> {
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
    return (await client.query(text)).rows as T[];
  } finally {
    await client.end();
  }
}

let app: INestApplication;
let base = '';
const run = randomUUID().slice(0, 8);
const srcSchema = `m4_src_${run}`;
const readerRole = `m4_reader_${run}`;
const writerRole = `m4_writer_${run}`;
const readerPassword = `Rd-${randomBytes(12).toString('hex')}`;
const writerPassword = `Wr-${randomBytes(12).toString('hex')}`;

beforeAll(async () => {
  f = await createFixture();
  process.env.LOCAL_KEK_BASE64 ??= randomBytes(32).toString('base64');
  process.env.CONNECTOR_ALLOW_PRIVATE_NETWORKS = 'true'; // the "customer" database is local
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

  // A source schema with two tables, a read-only role and a role that can write.
  const raw = admin;
  await raw(`CREATE SCHEMA ${srcSchema}`);
  await raw(
    `CREATE TABLE ${srcSchema}.customers (id integer PRIMARY KEY, name text NOT NULL, gstin text)`,
  );
  await raw(
    `CREATE TABLE ${srcSchema}.invoices (invoice_no text, customer_id integer, amount numeric(12,2))`,
  );
  await raw(`CREATE TABLE ${srcSchema}.hidden (secret text)`);
  await raw(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}'`);
  await raw(`CREATE ROLE ${writerRole} LOGIN PASSWORD '${writerPassword}'`);
  for (const role of [readerRole, writerRole]) {
    await raw(`GRANT CONNECT ON DATABASE ${env().POSTGRES_DB} TO ${role}`);
    await raw(`GRANT USAGE ON SCHEMA ${srcSchema} TO ${role}`);
    await raw(`GRANT SELECT ON ${srcSchema}.customers, ${srcSchema}.invoices TO ${role}`);
  }
  await raw(`GRANT INSERT ON ${srcSchema}.invoices TO ${writerRole}`);
});

afterAll(async () => {
  const raw = admin;
  await raw(`DROP SCHEMA ${srcSchema} CASCADE`).catch(() => undefined);
  await raw(`DROP ROLE IF EXISTS ${readerRole}`).catch(() => undefined);
  await raw(`DROP ROLE IF EXISTS ${writerRole}`).catch(() => undefined);
  await app.close();
  await f.close();
});

const call = (
  path: string,
  o: { token: string; tenant: string; method?: string; body?: unknown },
) =>
  fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: {
      authorization: `Bearer ${o.token}`,
      'x-tenant-id': o.tenant,
      'content-type': 'application/json',
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

const e = env();
const connection = (overrides: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port: e.POSTGRES_PORT,
  database: e.POSTGRES_DB,
  schema: srcSchema,
  tls_mode: 'disable',
  ...overrides,
});
const a = () => ({ token: 'ownerA', tenant: f.A.tenantId });
const b = () => ({ token: 'ownerB', tenant: f.B.tenantId });

async function createSource(
  who: { token: string; tenant: string },
  name: string,
  username: string,
  password: string,
) {
  const res = await call('/v1/data-sources', {
    ...who,
    method: 'POST',
    body: {
      name,
      type: 'postgresql',
      connection: connection(),
      credentials: { username, password },
    },
  });
  return {
    res,
    text: await res.clone().text(),
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe('data sources (E4.1)', () => {
  it('creates a source without ever returning the credential, and stores only ciphertext', async () => {
    const { res, text, body } = await createSource(
      a(),
      `Sales DB ${run}`,
      readerRole,
      readerPassword,
    );
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ type: 'postgresql', has_credentials: true, status: 'draft' });
    expect(text).not.toContain(readerPassword);
    expect(text).not.toContain('credential_id');

    const listText = await (await call('/v1/data-sources', a())).text();
    expect(listText).not.toContain(readerPassword);
    expect(listText).toContain(`Sales DB ${run}`);

    // At rest: the password is not in the stored bytes, the connection holds no secret.
    const stored = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.connector_credential')
        .select(['ciphertext'])
        .execute()
        .then(async (creds) => ({
          creds,
          sources: await tx.selectFrom('core.data_source').select('connection').execute(),
        })),
    );
    expect(stored.creds.length).toBeGreaterThan(0);
    for (const c of stored.creds)
      expect(c.ciphertext.includes(Buffer.from(readerPassword))).toBe(false);
    expect(JSON.stringify(stored.sources)).not.toContain(readerPassword);

    // Audit holds identifiers only.
    const audit = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'metadata'])
        .where('action', '=', 'data_source.created')
        .execute(),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(readerPassword);
  });

  it('rejects invalid input without echoing the submitted password', async () => {
    const secret = `Leak-${randomBytes(8).toString('hex')}`;
    const unknown = await call('/v1/data-sources', {
      ...a(),
      method: 'POST',
      body: { name: 'x', type: 'oracle', connection: {}, credentials: { password: secret } },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain(secret);

    const badCreds = await call('/v1/data-sources', {
      ...a(),
      method: 'POST',
      body: {
        name: 'y',
        type: 'postgresql',
        connection: connection(),
        credentials: { username: 'u', password: secret, extra: secret },
      },
    });
    expect(badCreds.status).toBe(400);
    expect(await badCreds.text()).not.toContain(secret);

    const noTls = await call('/v1/data-sources', {
      ...a(),
      method: 'POST',
      body: {
        name: 'z',
        type: 'postgresql',
        connection: connection({ host: 'db.example.com', tls_mode: 'bogus' }),
        credentials: { username: 'u', password: secret },
      },
    });
    expect(noTls.status).toBe(400);
  });

  it('keeps names unique per tenant, and a name may repeat in another tenant', async () => {
    const name = `Dup ${run}`;
    expect((await createSource(a(), name, readerRole, readerPassword)).res.status).toBe(201);
    expect((await createSource(a(), name, readerRole, readerPassword)).res.status).toBe(409);
    expect((await createSource(b(), name, readerRole, readerPassword)).res.status).toBe(201);
  });

  it('requires data_source:manage', async () => {
    const viewer = { token: 'viewerA', tenant: f.A.tenantId };
    expect((await call('/v1/data-sources', viewer)).status).toBe(403);
    expect((await call('/v1/connectors', viewer)).status).toBe(403);
    expect(
      (
        await call('/v1/data-sources', {
          ...viewer,
          method: 'POST',
          body: { name: 'v', type: 'postgresql', connection: connection() },
        })
      ).status,
    ).toBe(403);
  });

  it('isolates tenants: B sees nothing of A and cannot test or discover A sources', async () => {
    const created = await createSource(a(), `Private ${run}`, readerRole, readerPassword);
    const id = created.body.id as string;
    expect(await (await call('/v1/data-sources', b())).text()).not.toContain(`Private ${run}`);
    expect((await call(`/v1/data-sources/${id}`, b())).status).toBe(404);
    expect((await call(`/v1/data-sources/${id}/test`, { ...b(), method: 'POST' })).status).toBe(
      404,
    );
    expect(
      (await call(`/v1/data-sources/${id}/discover-schema`, { ...b(), method: 'POST' })).status,
    ).toBe(404);
    // B asking for A's id while using A's tenant header is rejected by membership.
    expect(
      (await call(`/v1/data-sources/${id}`, { token: 'ownerB', tenant: f.A.tenantId })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('lists the available connectors with capability descriptors', async () => {
    const list = (await (await call('/v1/connectors', a())).json()) as { connector_type: string }[];
    expect(list.map((c) => c.connector_type)).toContain('postgresql');
  });
});

describe('PostgreSQL connector (E4.3)', () => {
  it('tests a connection and reports no warnings for a read-only user', async () => {
    const { body } = await createSource(a(), `RO ${run}`, readerRole, readerPassword);
    const res = await call(`/v1/data-sources/${body.id as string}/test`, {
      ...a(),
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, errors: [], privilege_warnings: [] });
    const row = await call(`/v1/data-sources/${body.id as string}`, a());
    expect(await row.json()).toMatchObject({ status: 'connected' });
  });

  it('warns when the user can change data', async () => {
    const { body } = await createSource(a(), `RW ${run}`, writerRole, writerPassword);
    const res = await call(`/v1/data-sources/${body.id as string}/test`, {
      ...a(),
      method: 'POST',
    });
    const result = (await res.json()) as { ok: boolean; privilege_warnings: string[] };
    expect(result.ok).toBe(true);
    expect(result.privilege_warnings.join(' ')).toMatch(/change data/);
  });

  it('reports a bad password with a fixed message that names no secret', async () => {
    const { body } = await createSource(a(), `Bad ${run}`, readerRole, 'wrong-password');
    const res = await call(`/v1/data-sources/${body.id as string}/test`, {
      ...a(),
      method: 'POST',
    });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      errors: ['authentication failed'],
      privilege_warnings: [],
    });
    expect(text).not.toContain('wrong-password');
    const row = await call(`/v1/data-sources/${body.id as string}`, a());
    expect(await row.json()).toMatchObject({ status: 'error' });
  });

  it('reports an unreachable source without driver text', async () => {
    const res = await call('/v1/data-sources', {
      ...a(),
      method: 'POST',
      body: {
        name: `Down ${run}`,
        type: 'postgresql',
        connection: connection({ port: 1 }),
        credentials: { username: readerRole, password: readerPassword },
      },
    });
    const id = ((await res.json()) as { id: string }).id;
    const test = await call(`/v1/data-sources/${id}/test`, { ...a(), method: 'POST' });
    expect(await test.json()).toEqual({
      ok: false,
      errors: ['the source could not be reached'],
      privilege_warnings: [],
    });
  });

  it('discovers only readable tables, with columns, keys and a stable fingerprint', async () => {
    const { body } = await createSource(a(), `Disc ${run}`, readerRole, readerPassword);
    const path = `/v1/data-sources/${body.id as string}/discover-schema`;
    const first = (await (await call(path, { ...a(), method: 'POST' })).json()) as {
      objects: {
        name: string;
        fields: { name: string; data_type: string; nullable: boolean; is_primary_key: boolean }[];
      }[];
      fingerprint: string;
    };
    expect(first.objects.map((o) => o.name).sort()).toEqual(['customers', 'invoices']);
    const customers = first.objects.find((o) => o.name === 'customers');
    expect(customers?.fields).toEqual([
      { name: 'id', data_type: 'integer', nullable: false, is_primary_key: true },
      { name: 'name', data_type: 'text', nullable: false, is_primary_key: false },
      { name: 'gstin', data_type: 'text', nullable: true, is_primary_key: false },
    ]);
    const invoices = first.objects.find((o) => o.name === 'invoices');
    expect(invoices?.fields.some((x) => x.is_primary_key)).toBe(false);
    expect(invoices?.fields.find((x) => x.name === 'amount')?.data_type).toBe('numeric(12,2)');

    const second = (await (await call(path, { ...a(), method: 'POST' })).json()) as {
      fingerprint: string;
    };
    expect(second.fingerprint).toBe(first.fingerprint);

    // Drift changes the fingerprint.
    await admin(`ALTER TABLE ${srcSchema}.customers ADD COLUMN city text`);
    const third = (await (await call(path, { ...a(), method: 'POST' })).json()) as {
      fingerprint: string;
    };
    expect(third.fingerprint).not.toBe(first.fingerprint);
  });
});

describe('TI-04 catalog covers the new tables', () => {
  it('has forced RLS on data_source and connector_credential', async () => {
    const rows = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'core' AND c.relname IN ('data_source', 'connector_credential')`.execute(
      f.owner,
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });
});
