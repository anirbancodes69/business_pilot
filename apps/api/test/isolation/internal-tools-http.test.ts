import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import { seedSynthetic } from '../../src/dev/seed-synthetic';
import { syntheticDistributor } from '../../src/dev/synthetic-distributor';
import { RequestContextSigner } from '../../src/platform/service-auth/request-context';
import { requestIdMiddleware } from '../../src/platform/request-id/request-id';
import { createFixture, type Fixture } from './harness';

// The internal execute-plan endpoint over real HTTP (E6.3): the service token, the signed request
// context, the request id, scope changes, the call budget and tenant separation.

const SERVICE_TOKEN = randomBytes(24).toString('hex');
const SIGNING_KEY = randomBytes(32).toString('hex');
const data = syntheticDistributor();
const pune = data.branch.find((b) => b.name === 'Pune')?.id as string;
const authz = new AuthorizationService();
const signer = new RequestContextSigner([SIGNING_KEY]);

let f: Fixture;
let app: INestApplication;
let base = '';

const plan = (over: Record<string, unknown> = {}) => ({
  plan_version: '0.1',
  semantic_model_version: 1,
  intent: 'ranking',
  measures: ['revenue'],
  dimensions: [{ id: 'branch.name' }],
  time_range: { start: '2026-04-01', end: '2026-11-15' },
  ...over,
});

beforeAll(async () => {
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.REQUEST_CONTEXT_SIGNING_KEY = SIGNING_KEY;
  process.env.RESULT_CACHE_ENABLED = 'false'; // this file tests the endpoint, not the cache
  process.env.LOCAL_KEK_BASE64 ??= randomBytes(32).toString('base64');
  f = await createFixture();
  await f.db.tenantTx(f.A.tenantId, (tx) => seedSynthetic(tx, f.A.tenantId, data));
  // Tenant B has data of its own, different from A's.
  await f.db.tenantTx(f.B.tenantId, (tx) =>
    seedSynthetic(tx, f.B.tenantId, syntheticDistributor(7)),
  );
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
      .values({ tenant_id: f.A.tenantId, membership_id: f.A.viewerMembershipId, role_id: role.id })
      .execute();
    await tx
      .updateTable('core.tenant_membership')
      .set({ attributes: JSON.stringify({ assigned_branch_ids: [pune] }) })
      .where('id', '=', f.A.viewerMembershipId)
      .execute();
  });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.use(requestIdMiddleware);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await f.close();
});

async function context(
  who: 'ownerA' | 'viewerA' | 'ownerB',
  over: { maxCalls?: number; scope?: string; signer?: RequestContextSigner } = {},
) {
  const [tenantId, userId, membershipId] =
    who === 'ownerA'
      ? [f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId]
      : who === 'viewerA'
        ? [f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId]
        : [f.B.tenantId, f.B.ownerUserId, f.B.ownerMembershipId];
  const ctx = await f.db.tenantTx(tenantId, (tx) => authz.load(tx, tenantId, userId, membershipId));
  const requestId = randomUUID();
  const token = (over.signer ?? signer).issue({
    request_id: requestId,
    tenant_id: tenantId,
    user_id: userId,
    authz_scope_hash: over.scope ?? ctx.authz_scope_hash,
    semantic_model_version: 1,
    max_tool_calls: over.maxCalls ?? 6,
  });
  return { token, requestId };
}

const call = (body: unknown, headers: Record<string, string>) =>
  fetch(`${base}/internal/v1/tools/execute-plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const asService = (requestId: string, token = SERVICE_TOKEN) => ({
  authorization: `Bearer ${token}`,
  'x-request-id': requestId,
});

describe('POST /internal/v1/tools/execute-plan', () => {
  it('needs the service token', async () => {
    const { token, requestId } = await context('ownerA');
    const body = { request_context: token, plan: plan() };
    expect((await call(body, { 'x-request-id': requestId })).status).toBe(401);
    expect((await call(body, asService(requestId, 'wrong-token-wrong-token'))).status).toBe(401);
  });

  it('runs a plan for the user in the signed context, with sources and freshness', async () => {
    const { token, requestId } = await context('ownerA');
    const res = await call({ request_context: token, plan: plan() }, asService(requestId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result_sets: { rows: unknown[][] }[];
      sources: unknown[];
      freshness: unknown[];
      cache_hit: boolean;
      semantic_model_version: number;
    };
    expect(body.result_sets[0]?.rows.map((r) => r[0]).sort()).toEqual(['Nagpur', 'Nashik', 'Pune']);
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.freshness.length).toBeGreaterThan(0);
    expect(body.cache_hit).toBe(false);
    expect(body.semantic_model_version).toBe(1);
  });

  it('refuses a context for another request id, a forged signature and an expired token', async () => {
    const { token, requestId } = await context('ownerA');
    const body = { request_context: token, plan: plan() };
    expect((await call(body, asService(randomUUID()))).status).toBe(401); // replayed for another request
    const forged = await context('ownerA', { signer: new RequestContextSigner(['f'.repeat(40)]) });
    expect(
      (await call({ request_context: forged.token, plan: plan() }, asService(forged.requestId)))
        .status,
    ).toBe(401);
    const past = new RequestContextSigner([SIGNING_KEY], () => new Date(Date.now() - 600_000));
    const old = await context('ownerA', { signer: past });
    expect(
      (await call({ request_context: old.token, plan: plan() }, asService(old.requestId))).status,
    ).toBe(401);
    const [p, s] = token.split('.');
    expect(
      (
        await call(
          { request_context: `${p}.${s?.slice(0, -2)}xx`, plan: plan() },
          asService(requestId),
        )
      ).status,
    ).toBe(401);
  });

  it('refuses when the user’s authorization is no longer what the context says', async () => {
    const { token, requestId } = await context('ownerA', { scope: 'a'.repeat(64) });
    expect(
      (await call({ request_context: token, plan: plan() }, asService(requestId))).status,
    ).toBe(403);
  });

  it('answers 422 for an invalid plan and 403 for one outside the user’s grants', async () => {
    const owner = await context('ownerA');
    expect(
      (
        await call(
          { request_context: owner.token, plan: { nonsense: true } },
          asService(owner.requestId),
        )
      ).status,
    ).toBe(422);
    const sales = await context('viewerA');
    const denied = await call(
      { request_context: sales.token, plan: plan({ measures: ['outstanding_receivables'] }) },
      asService(sales.requestId),
    );
    expect(denied.status).toBe(403);
  });

  it('applies the sales manager’s branch restriction through the endpoint', async () => {
    const { token, requestId } = await context('viewerA');
    const res = await call({ request_context: token, plan: plan() }, asService(requestId));
    const body = (await res.json()) as { result_sets: { rows: unknown[][] }[] };
    expect(body.result_sets[0]?.rows.map((r) => r[0])).toEqual(['Pune']);
  });

  it('takes no tenant or user from the body', async () => {
    const { token, requestId } = await context('ownerA');
    const res = await call(
      { request_context: token, plan: plan(), tenant_id: f.B.tenantId },
      asService(requestId),
    );
    expect(res.status).toBe(422);
    const other = await call(
      { request_context: token, plan: plan({ tenant_id: f.B.tenantId }) },
      asService(requestId),
    );
    expect(other.status).toBe(422);
  });

  it('serves each tenant only its own data', async () => {
    const a = await context('ownerA');
    const b = await context('ownerB');
    const run = async (c: { token: string; requestId: string }) => {
      const res = await call({ request_context: c.token, plan: plan() }, asService(c.requestId));
      expect(res.status).toBe(200);
      return (await res.json()) as {
        result_sets: { rows: unknown[][] }[];
        sources: { data_source_id: string }[];
      };
    };
    const [ra, rb] = [await run(a), await run(b)];
    expect(rb.result_sets[0]?.rows).not.toEqual(ra.result_sets[0]?.rows);
    const sourceIds = new Set(ra.sources.map((x) => x.data_source_id));
    expect(rb.sources.every((x) => !sourceIds.has(x.data_source_id))).toBe(true);
  });

  it('stops a request at its call budget with 429', async () => {
    const { token, requestId } = await context('ownerA', { maxCalls: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await call({ request_context: token, plan: plan() }, asService(requestId))).status,
      );
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
