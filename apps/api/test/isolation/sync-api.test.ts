import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier, UnauthenticatedError } from '../../src/identity/token-verifier';
import { requestIdMiddleware } from '../../src/platform/request-id/request-id';
import { makeXlsx } from '../fixtures/xlsx';
import { createFixture, type Fixture } from './harness';

// E5.1 and E5.5 (in part): the sync HTTP endpoints, their permissions and tenant isolation.

let f: Fixture;
let app: INestApplication;
let base = '';
const redis = Boolean(process.env.REDIS_URL);

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

async function newSource(who: Who): Promise<string> {
  const res = await api('/v1/data-sources', {
    ...who,
    method: 'POST',
    body: {
      name: `sync api ${Math.random()}`,
      type: 'excel',
      connection: { upload_mode: 'manual' },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('sync endpoints', () => {
  it.skipIf(!redis)('queues a sync for a manager and refuses a viewer', async () => {
    const id = await newSource(a());
    const ok = await api(`/v1/data-sources/${id}/sync`, { ...a(), method: 'POST' });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { jobId: string }).jobId).toContain(id);
    const no = await api(`/v1/data-sources/${id}/sync`, { ...viewer(), method: 'POST' });
    expect(no.status).toBe(403);
  });

  it.skipIf(!redis)('queues a sync after an upload', async () => {
    const id = await newSource(a());
    const res = await fetch(`${base}/v1/data-sources/${id}/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ownerA',
        'x-tenant-id': f.A.tenantId,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(makeXlsx([{ name: 'S', rows: [['K'], ['1']] }])),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { sync_queued: boolean }).sync_queued).toBe(true);
  });

  it('does not let tenant B request, list or read anything of tenant A', async () => {
    const id = await newSource(a());
    expect((await api(`/v1/data-sources/${id}/sync`, { ...b(), method: 'POST' })).status).toBe(404);
    for (const path of ['sync-runs', 'datasets']) {
      const res = await api(`/v1/data-sources/${id}/${path}`, b());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
    const dead = await api(
      `/v1/data-sources/${id}/sync-runs/00000000-0000-4000-8000-000000000000/dead-letters`,
      b(),
    );
    expect(await dead.json()).toEqual([]);
  });

  it('rejects a viewer on the read endpoints and a bad id', async () => {
    const id = await newSource(a());
    expect((await api(`/v1/data-sources/${id}/sync-runs`, viewer())).status).toBe(403);
    expect((await api(`/v1/data-sources/${id}/datasets`, viewer())).status).toBe(403);
    expect((await api('/v1/data-sources/not-a-uuid/sync-runs', a())).status).toBe(404);
  });

  it('lists notifications per tenant, marks one read, and needs data_source:manage', async () => {
    const id = await newSource(a());
    const noteId = await f.db.tenantTx(
      f.A.tenantId,
      async (tx) =>
        (
          await tx
            .insertInto('core.notification')
            .values({
              tenant_id: f.A.tenantId,
              kind: 'sync.failed',
              severity: 'warning',
              data_source_id: id,
              metadata: JSON.stringify({ error_code: 'x' }),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    );
    const mine = (await (await api('/v1/notifications', a())).json()) as {
      id: string;
      read_at: string | null;
    }[];
    expect(mine.find((n) => n.id === noteId)?.read_at).toBeNull();
    expect(await (await api('/v1/notifications', b())).json()).toEqual([]);
    expect((await api('/v1/notifications', viewer())).status).toBe(403);
    expect((await api(`/v1/notifications/${noteId}/read`, { ...b(), method: 'POST' })).status).toBe(
      404,
    );
    expect((await api(`/v1/notifications/${noteId}/read`, { ...a(), method: 'POST' })).status).toBe(
      200,
    );
    expect((await api(`/v1/notifications/${noteId}/read`, { ...a(), method: 'POST' })).status).toBe(
      404,
    );
  });
});
