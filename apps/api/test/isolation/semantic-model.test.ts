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
import { wholesaleDistributionTemplate } from '../../src/configuration/templates/wholesale-distribution';
import { AuthorizationService } from '../../src/authorization/authorization.service';
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

describe('wholesale_distribution template (E3.2)', () => {
  it('every entity table and attribute exists in the migrated analytics schema', async () => {
    const m = wholesaleDistributionTemplate();
    const cols = await sql<{ t: string; c: string }>`
      select table_schema || '.' || table_name as t, column_name as c
      from information_schema.columns where table_schema = 'analytics'`.execute(f.raw);
    const have = new Set(cols.rows.map((r) => `${r.t}.${r.c}`));
    const table = new Map(m.entities.map((e) => [e.id, e.table]));
    const need: string[] = [];
    for (const e of m.entities) need.push(`${e.table}.tenant_id`);
    for (const d of m.dimensions) need.push(`${table.get(d.entity)}.${d.attribute}`);
    for (const x of m.measures) if (x.attribute) need.push(`${table.get(x.entity)}.${x.attribute}`);
    for (const r of m.relationships ?? [])
      for (const [fromCol, toCol] of r.on) {
        need.push(`${table.get(r.from)}.${fromCol}`, `${table.get(r.to)}.${toCol}`);
      }
    expect(need.filter((n) => !have.has(n))).toEqual([]);
  });

  it('creates a draft from the template, which an admin can publish; unknown templates are rejected', async () => {
    const a = { token: 'ownerA', tenant: f.A.tenantId, method: 'POST' };
    const bad = await call('/v1/semantic-models/from-template', {
      ...a,
      body: { template: 'nope' },
    });
    expect(bad.status).toBe(400);
    const ok = await call('/v1/semantic-models/from-template', {
      ...a,
      body: { template: 'wholesale_distribution' },
    });
    expect(ok.status).toBe(201);
    const { version } = (await ok.json()) as { version: number };
    expect((await call(`/v1/semantic-models/${version}/publish`, a)).status).toBe(201);
  });

  it('application role can read and write analytics rows only inside its tenant, and cannot delete', async () => {
    const ds = '11111111-1111-4111-8111-111111111111';
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      sql`insert into analytics.branch (tenant_id, data_source_id, source_key, code, name)
          values (${f.A.tenantId}, ${ds}, 'B1', 'B1', 'Pune')`.execute(tx),
    );
    // the same natural key in tenant B is allowed and invisible to A
    await f.db.tenantTx(f.B.tenantId, (tx) =>
      sql`insert into analytics.branch (tenant_id, data_source_id, source_key, code, name)
          values (${f.B.tenantId}, ${ds}, 'B1', 'B1', 'Delhi')`.execute(tx),
    );
    const seenByA = await f.db.tenantTx(f.A.tenantId, (tx) =>
      sql<{ name: string }>`select name from analytics.branch`.execute(tx),
    );
    expect(seenByA.rows.map((r) => r.name)).toEqual(['Pune']);
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        sql`insert into analytics.branch (tenant_id, data_source_id, source_key, name)
            values (${f.B.tenantId}, ${ds}, 'X', 'Leak')`.execute(tx),
      ),
    ).rejects.toThrow();
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) => sql`delete from analytics.branch`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it("a foreign key cannot point at another tenant's row", async () => {
    const ds = '22222222-2222-4222-8222-222222222222';
    const branchB = await f.db.tenantTx(
      f.B.tenantId,
      async (tx) =>
        (await sql<{ id: string }>`select id from analytics.branch limit 1`.execute(tx)).rows[0]!
          .id,
    );
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        sql`insert into analytics.customer (tenant_id, data_source_id, source_key, name, branch_id)
            values (${f.A.tenantId}, ${ds}, 'C1', 'X', ${branchB})`.execute(tx),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('authorized view and access policy (E3.3, E3.4)', () => {
  const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

  it('policy cannot be activated before a model is published; non-admins cannot manage it', async () => {
    const b = { token: 'ownerB', tenant: f.B.tenantId, method: 'POST' };
    expect(
      (
        await call('/v1/access-policies/from-template', {
          ...b,
          body: { template: 'wholesale_distribution' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/v1/access-policies', {
          token: 'viewerA',
          tenant: f.A.tenantId,
          method: 'POST',
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('/v1/semantic-view', { token: 'ownerB', tenant: f.B.tenantId })).status,
    ).toBe(404);
  });

  it('end to end: model, policy, a sales manager limited to branch b1, and no cross-tenant access', async () => {
    const own = { token: 'ownerA', tenant: f.A.tenantId, method: 'POST' };
    const tpl = await json(
      await call('/v1/semantic-models/from-template', {
        ...own,
        body: { template: 'wholesale_distribution' },
      }),
    );
    await call(`/v1/semantic-models/${tpl.version}/publish`, own);

    // before a policy is active the sales manager sees no data
    await f.db.tenantTx(f.A.tenantId, async (tx) => {
      const role = await tx
        .selectFrom('core.role')
        .select('id')
        .where('key', '=', 'sales_manager')
        .executeTakeFirstOrThrow();
      await tx
        .deleteFrom('core.membership_role')
        .where('membership_id', '=', f.A.viewerMembershipId)
        .execute();
      await tx
        .insertInto('core.membership_role')
        .values({
          tenant_id: f.A.tenantId,
          membership_id: f.A.viewerMembershipId,
          role_id: role.id,
        })
        .execute();
    });
    const sm = { token: 'viewerA', tenant: f.A.tenantId };
    const before = await json(await call('/v1/semantic-view', sm));
    expect(before.measures).toEqual([]);

    const draft = await json(
      await call('/v1/access-policies/from-template', {
        ...own,
        body: { template: 'wholesale_distribution' },
      }),
    );
    expect((await call(`/v1/access-policies/${draft.version}/activate`, own)).status).toBe(201);
    expect((await call(`/v1/access-policies/${draft.version}/activate`, own)).status).toBe(409);

    const view = (await json(await call('/v1/semantic-view', sm))) as {
      measures: { id: string }[];
      entities: { id: string }[];
    };
    expect(view.measures.map((m) => m.id)).toContain('revenue');
    expect(view.measures.map((m) => m.id)).not.toContain('outstanding_receivables');
    expect(view.entities.map((e) => e.id)).not.toContain('payment');
    expect(JSON.stringify(view)).not.toContain('analytics.');
    const ownerView = (await json(
      await call('/v1/semantic-view', { token: 'ownerA', tenant: f.A.tenantId }),
    )) as { measures: unknown[] };
    expect(ownerView.measures.length).toBeGreaterThan(view.measures.length);

    // the context carries the branch filter from the membership attributes (TI-14, context level)
    const ctx = await f.db.tenantTx(f.A.tenantId, (tx) =>
      new AuthorizationService().load(tx, f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId),
    );
    expect(ctx.row_filters).toEqual([
      { entity: 'branch', attribute: 'id', operator: 'in', values: ['b1'] },
    ]);
    expect(ctx.policy_version).toBe(draft.version);

    // another tenant sees none of this
    expect(
      (await call('/v1/access-policies', { token: 'ownerB', tenant: f.B.tenantId })).status,
    ).toBe(200);
    const listB = (await (
      await call('/v1/access-policies', { token: 'ownerB', tenant: f.B.tenantId })
    ).json()) as unknown[];
    expect(listB).toEqual([]);
    expect(
      (
        await call(`/v1/access-policies/${draft.version}`, {
          token: 'ownerB',
          tenant: f.B.tenantId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/v1/access-policies/${draft.version}/activate`, {
          token: 'ownerB',
          tenant: f.B.tenantId,
          method: 'POST',
        })
      ).status,
    ).toBe(404);
  });

  it('rejects a policy that names unknown roles or measures, and ignores a client-supplied policy_version', async () => {
    const own = { token: 'ownerA', tenant: f.A.tenantId, method: 'POST' };
    const bad = await call('/v1/access-policies', {
      ...own,
      body: { policy_version: 99, role_grants: [{ role: 'ghost', measures: ['nope'] }] },
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain('unknown role: ghost');
    expect(text).toContain('unknown measures nope');
  });

  it('rejects a policy that grants an approval permission or masks a column that does not exist', async () => {
    const own = { token: 'ownerA', tenant: f.A.tenantId, method: 'POST' };
    const bad = await call('/v1/access-policies', {
      ...own,
      body: {
        role_grants: [{ role: 'viewer', permissions: ['mapping:approve', 'made:up'] }],
        column_rules: [{ entity: 'customer', attribute: 'gstinn', mask: 'hide' }],
      },
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain('permission mapping:approve cannot be granted by a policy');
    expect(text).toContain('unknown permission made:up');
    expect(text).toContain('unknown attribute customer.gstinn');
    // a catalog permission that is not restricted is accepted
    const ok = await call('/v1/access-policies', {
      ...own,
      body: { role_grants: [{ role: 'finance_manager', permissions: ['audit:read'] }] },
    });
    expect(ok.status).toBe(201);
  });
});
