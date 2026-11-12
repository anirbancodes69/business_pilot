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
import { validModel } from '../fixtures/semantic-model';
import { createFixture, type Fixture } from './harness';

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

describe('semantic model versions (E3.1)', () => {
  it('draft, publish, immutability and retirement', async () => {
    const a = { token: 'ownerA', tenant: f.A.tenantId };
    const created = await call('/v1/semantic-models', { ...a, method: 'POST', body: validModel() });
    expect(created.status).toBe(201);
    const v1 = ((await created.json()) as { version: number }).version;

    const edit = await call(`/v1/semantic-models/${v1}`, {
      ...a,
      method: 'PUT',
      body: validModel(),
    });
    expect(edit.status).toBe(200);
    expect((await call(`/v1/semantic-models/${v1}/publish`, { ...a, method: 'POST' })).status).toBe(
      201,
    );
    // published: cannot be edited or published again
    expect(
      (await call(`/v1/semantic-models/${v1}`, { ...a, method: 'PUT', body: validModel() })).status,
    ).toBe(409);
    expect((await call(`/v1/semantic-models/${v1}/publish`, { ...a, method: 'POST' })).status).toBe(
      409,
    );

    // a second version replaces the first as the published one
    const v2 = (
      (await (
        await call('/v1/semantic-models', { ...a, method: 'POST', body: validModel() })
      ).json()) as { version: number }
    ).version;
    expect(v2).toBe(v1 + 1);
    await call(`/v1/semantic-models/${v2}/publish`, { ...a, method: 'POST' });
    const list = (await (await call('/v1/semantic-models', a)).json()) as {
      version: number;
      status: string;
    }[];
    expect(list.find((r) => r.version === v1)?.status).toBe('retired');
    expect(list.find((r) => r.version === v2)?.status).toBe('published');

    // audit trail
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select('action')
        .where('action', 'like', 'semantic_model.%')
        .execute(),
    );
    expect(events.map((e) => e.action)).toContain('semantic_model.published');
  });

  it('rejects an invalid model with problems, and creates nothing', async () => {
    const before = (await (
      await call('/v1/semantic-models', { token: 'ownerA', tenant: f.A.tenantId })
    ).json()) as unknown[];
    const bad = validModel();
    bad.measures[0]!.entity = 'nope';
    const res = await call('/v1/semantic-models', {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'POST',
      body: bad,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('unknown entity nope');
    const after = (await (
      await call('/v1/semantic-models', { token: 'ownerA', tenant: f.A.tenantId })
    ).json()) as unknown[];
    expect(after).toHaveLength(before.length);
  });

  it('the database refuses to change a published document, even for the application role', async () => {
    const a = { token: 'ownerA', tenant: f.A.tenantId };
    await call('/v1/semantic-models', { ...a, method: 'POST', body: validModel() });
    const list = (await (await call('/v1/semantic-models', a)).json()) as {
      version: number;
      status: string;
    }[];
    const published = list.find((r) => r.status === 'published')!;
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        sql`update core.semantic_model set document = '{}'::jsonb where version = ${published.version}`.execute(
          tx,
        ),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("TI-05: tenant B cannot see, edit or publish tenant A's versions; a viewer cannot manage", async () => {
    const created = await call('/v1/semantic-models', {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'POST',
      body: validModel(),
    });
    const v = ((await created.json()) as { version: number }).version;
    const b = { token: 'ownerB', tenant: f.B.tenantId };
    // B has no model yet with that version number, so A's version is simply absent for B
    expect((await call(`/v1/semantic-models/${v}`, b)).status).toBe(404);
    expect((await call(`/v1/semantic-models/${v}/publish`, { ...b, method: 'POST' })).status).toBe(
      404,
    );
    expect(
      (await call(`/v1/semantic-models/${v}`, { ...b, method: 'PUT', body: validModel() })).status,
    ).toBe(404);
    expect(((await (await call('/v1/semantic-models', b)).json()) as unknown[]).length).toBe(0);
    // forged tenant selection
    expect(
      (await call(`/v1/semantic-models/${v}`, { token: 'ownerB', tenant: f.A.tenantId })).status,
    ).toBe(403);
    // the viewer role has no semantic_model permissions
    expect(
      (await call('/v1/semantic-models', { token: 'viewerA', tenant: f.A.tenantId })).status,
    ).toBe(403);
  });
});
