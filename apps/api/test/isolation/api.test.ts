import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { TokenVerifier, UnauthenticatedError } from '../../src/identity/token-verifier';
import { requestIdMiddleware } from '../../src/platform/request-id/request-id';
import { createFixture, type Fixture } from './harness';

let f: Fixture;
let app: INestApplication;
let base = '';

beforeAll(async () => {
  f = await createFixture();
  process.env.LOCAL_KEK_BASE64 ??= randomBytes(32).toString('base64');
  // Only the token check is replaced; guards, database and RLS are the real ones.
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
  o: { token?: string; tenant?: string; method?: string; body?: unknown } = {},
) =>
  fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: {
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.tenant ? { 'x-tenant-id': o.tenant } : {}),
      'content-type': 'application/json',
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

describe('TI-05 API: client-supplied tenant or resource IDs never cross tenants', () => {
  it('requires authentication', async () => {
    expect((await call('/v1/me')).status).toBe(401);
    expect((await call('/v1/tenant', { token: 'garbage', tenant: f.A.tenantId })).status).toBe(401);
  });

  it('a tenant selection is only a request: a non-member gets 403 for tenant B (and for a random tenant alike)', async () => {
    const forB = await call('/v1/tenant', { token: 'ownerA', tenant: f.B.tenantId });
    const random = await call('/v1/tenant', {
      token: 'ownerA',
      tenant: '99999999-9999-4999-8999-999999999999',
    });
    expect(forB.status).toBe(403);
    expect(random.status).toBe(403);
    expect(await forB.text()).toBe(await random.text()); // indistinguishable
    expect((await call('/v1/tenant', { token: 'ownerA' })).status).toBe(403); // no selection
    expect((await call('/v1/tenant', { token: 'ownerA', tenant: 'not-a-uuid' })).status).toBe(403);
  });

  it('a member reads only their own tenant', async () => {
    const res = await call('/v1/tenant', { token: 'ownerA', tenant: f.A.tenantId });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(f.A.tenantId);
  });

  it("tenant B's membership IDs are 404 from tenant A, for reads and writes, and nothing changes", async () => {
    const get = await call(`/v1/memberships/${f.B.ownerMembershipId}`, {
      token: 'ownerA',
      tenant: f.A.tenantId,
    });
    expect(get.status).toBe(404);
    const put = await call(`/v1/memberships/${f.B.ownerMembershipId}/roles`, {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'PUT',
      body: { roles: ['viewer'] },
    });
    expect(put.status).toBe(404);
    const rolesB = await f.db.tenantTx(f.B.tenantId, (tx) =>
      tx
        .selectFrom('core.membership_role')
        .select('membership_id')
        .where('membership_id', '=', f.B.ownerMembershipId)
        .execute(),
    );
    expect(rolesB).toHaveLength(1);
  });

  it('a forged tenant_id in the request body is rejected, not honoured', async () => {
    const res = await call(`/v1/memberships/${f.A.viewerMembershipId}/roles`, {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'PUT',
      body: { roles: ['viewer'], tenant_id: f.B.tenantId },
    });
    expect(res.status).toBe(400);
  });

  it('lists never contain the other tenant (members, audit, me)', async () => {
    const members = (await (
      await call('/v1/memberships', { token: 'ownerA', tenant: f.A.tenantId })
    ).json()) as { id: string }[];
    expect(members.map((m) => m.id).sort()).toEqual(
      [f.A.ownerMembershipId, f.A.viewerMembershipId].sort(),
    );
    const audit = (await (
      await call('/v1/audit-events', { token: 'ownerA', tenant: f.A.tenantId })
    ).json()) as { target: string }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((e) => e.target === f.B.tenantId)).toBe(false);
    const me = (await (await call('/v1/me', { token: 'ownerA' })).json()) as {
      memberships: { tenant_id: string }[];
    };
    expect(me.memberships.map((m) => m.tenant_id)).toEqual([f.A.tenantId]);
  });
});

describe('authorization (RBAC, default deny, audit)', () => {
  it('a viewer cannot list members, read the audit log, or change roles', async () => {
    for (const [path, method, body] of [
      ['/v1/memberships', 'GET', undefined],
      ['/v1/audit-events', 'GET', undefined],
      [`/v1/memberships/${f.A.viewerMembershipId}/roles`, 'PUT', { roles: ['owner'] }],
    ] as const) {
      expect(
        (await call(path, { token: 'viewerA', tenant: f.A.tenantId, method, body })).status,
        path,
      ).toBe(403);
    }
    expect((await call('/v1/tenant', { token: 'viewerA', tenant: f.A.tenantId })).status).toBe(200);
  });

  it('an owner changes a role, the change is audited, and unknown roles are rejected', async () => {
    const ok = await call(`/v1/memberships/${f.A.viewerMembershipId}/roles`, {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'PUT',
      body: { roles: ['sales_manager'] },
    });
    expect(ok.status).toBe(200);
    const audit = (await (
      await call('/v1/audit-events', { token: 'ownerA', tenant: f.A.tenantId })
    ).json()) as { action: string; metadata: { before: string[]; after: string[] } }[];
    const ev = audit.find((e) => e.action === 'membership.roles_changed');
    expect(ev?.metadata).toEqual({ before: ['viewer'], after: ['sales_manager'] });
    expect(
      (
        await call(`/v1/memberships/${f.A.viewerMembershipId}/roles`, {
          token: 'ownerA',
          tenant: f.A.tenantId,
          method: 'PUT',
          body: { roles: ['god_mode'] },
        })
      ).status,
    ).toBe(400);
  });

  it('the last owner cannot be demoted', async () => {
    const res = await call(`/v1/memberships/${f.A.ownerMembershipId}/roles`, {
      token: 'ownerA',
      tenant: f.A.tenantId,
      method: 'PUT',
      body: { roles: ['viewer'] },
    });
    expect(res.status).toBe(409);
  });

  it('a suspended membership or tenant is refused', async () => {
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .updateTable('core.tenant_membership')
        .set({ status: 'suspended' })
        .where('id', '=', f.A.viewerMembershipId)
        .execute(),
    );
    expect((await call('/v1/tenant', { token: 'viewerA', tenant: f.A.tenantId })).status).toBe(403);
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .updateTable('core.tenant')
        .set({ status: 'suspended' })
        .where('id', '=', f.A.tenantId)
        .execute(),
    );
    expect((await call('/v1/tenant', { token: 'ownerA', tenant: f.A.tenantId })).status).toBe(403);
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .updateTable('core.tenant')
        .set({ status: 'active' })
        .where('id', '=', f.A.tenantId)
        .execute(),
    );
  });
});
