import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import { seedSynthetic } from '../../src/dev/seed-synthetic';
import { syntheticDistributor } from '../../src/dev/synthetic-distributor';
import { RedisResultCache } from '../../src/platform/cache/result-cache';
import { ContextRejected, PlanExecutor } from '../../src/query/plan-executor';
import type { QueryPlan } from '../../src/query/query-plan';
import { createFixture, env, type Fixture } from './harness';

// TI-07 (exact cache part, E6.7): a cached result is never served across tenants, across
// authorization scopes or across data versions, a hit never skips the authorization re-check, and a
// failing cache is only a miss. Needs the Redis of the isolation job.

const REDIS_URL = env().REDIS_URL;
const REDIS_PASSWORD = env().REDIS_PASSWORD;
const NOW = new Date('2026-11-15T04:30:00Z');
const authz = new AuthorizationService();
const data = syntheticDistributor();
const pune = data.branch.find((b) => b.name === 'Pune')?.id as string;

describe.skipIf(!REDIS_URL)('exact result cache (E6.7, TI-07)', () => {
  let f: Fixture;
  let redis: Redis;
  let executor: PlanExecutor;

  const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
    plan_version: '0.1',
    semantic_model_version: 1,
    intent: 'ranking',
    measures: ['revenue'],
    dimensions: [{ id: 'branch.name' }],
    time_range: { start: '2026-04-01', end: '2026-11-15' },
    ...over,
  });

  async function run(who: 'ownerA' | 'viewerA' | 'ownerB', p: QueryPlan, scopeHash?: string) {
    const [tenantId, userId, membershipId] =
      who === 'ownerA'
        ? [f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId]
        : who === 'viewerA'
          ? [f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId]
          : [f.B.tenantId, f.B.ownerUserId, f.B.ownerMembershipId];
    const ctx = await f.db.tenantTx(tenantId, (tx) =>
      authz.load(tx, tenantId, userId, membershipId),
    );
    return executor.execute({
      tenantId,
      userId,
      requestId: 'cache-0001',
      scopeHash: scopeHash ?? ctx.authz_scope_hash,
      modelVersion: 1,
      plan: p,
      now: NOW,
    });
  }
  const keysOf = (tenantId: string) => redis.keys(`t:${tenantId}:qc:*`);
  const rowsOf = (r: Awaited<ReturnType<typeof run>>) => r.result_sets[0]?.rows;

  beforeAll(async () => {
    f = await createFixture();
    redis = new Redis({
      host: new URL(REDIS_URL as string).hostname,
      port: Number(new URL(REDIS_URL as string).port || 6379),
      ...(REDIS_PASSWORD ? { password: REDIS_PASSWORD } : {}),
    });
    executor = new PlanExecutor(
      f.db,
      authz,
      new AuditService(),
      new RedisResultCache(REDIS_URL as string, REDIS_PASSWORD),
      { RESULT_CACHE_TTL_SECONDS: 120 },
    );
    for (const tenantId of [f.A.tenantId, f.B.tenantId]) {
      await f.db.tenantTx(tenantId, (tx) => seedSynthetic(tx, tenantId, data));
      await f.db.tenantTx(tenantId, (tx) =>
        tx
          .updateTable('core.dataset')
          .set({ data_version: 1 })
          .where('tenant_id', '=', tenantId)
          .execute(),
      );
    }
    // The viewer of tenant A becomes a sales manager limited to Pune.
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
      await tx
        .updateTable('core.tenant_membership')
        .set({ attributes: JSON.stringify({ assigned_branch_ids: [pune] }) })
        .where('id', '=', f.A.viewerMembershipId)
        .execute();
    });
  });
  afterAll(async () => {
    for (const t of [f.A.tenantId, f.B.tenantId]) {
      const keys = await keysOf(t);
      if (keys.length) await redis.del(...keys);
    }
    redis.disconnect();
    await f.close();
  });

  it('the second identical question is a hit with the same figures, and keys carry the tenant', async () => {
    const first = await run('ownerA', plan());
    const second = await run('ownerA', plan());
    expect([first.cache_hit, second.cache_hit]).toEqual([false, true]);
    expect(rowsOf(second)).toEqual(rowsOf(first));
    expect(second.data_executed_at).toBe(first.data_executed_at); // honest about when it was read
    const keys = await keysOf(f.A.tenantId);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith(`t:${f.A.tenantId}:qc:`))).toBe(true);
    expect(await keysOf(f.B.tenantId)).toEqual([]);
  });

  it('an equivalent plan (other order, other wording) shares the entry', async () => {
    const a = await run(
      'ownerA',
      plan({ measures: ['revenue', 'invoice_count'], rationale: 'one' }),
    );
    const b = await run(
      'ownerA',
      plan({ measures: ['invoice_count', 'revenue'], rationale: 'two' }),
    );
    expect([a.cache_hit, b.cache_hit]).toEqual([false, true]);
  });

  it('another tenant asking the same plan is a miss and gets its own entry', async () => {
    const b = await run('ownerB', plan());
    expect(b.cache_hit).toBe(false);
    expect((await keysOf(f.B.tenantId)).every((k) => k.startsWith(`t:${f.B.tenantId}:qc:`))).toBe(
      true,
    );
    expect((await run('ownerB', plan())).cache_hit).toBe(true);
  });

  it('a user with a different authorization scope never gets the owner’s cached result', async () => {
    const owner = await run('ownerA', plan());
    const sales = await run('viewerA', plan());
    expect(sales.cache_hit).toBe(false);
    expect(rowsOf(sales)).not.toEqual(rowsOf(owner));
    expect(rowsOf(sales)?.map((r) => r[0])).toEqual(['Pune']); // limited, as for any run
    expect((await run('viewerA', plan())).cache_hit).toBe(true); // and cached for that scope only
  });

  it('a sync that changes a dataset (a new data version) makes a new key', async () => {
    expect((await run('ownerA', plan())).cache_hit).toBe(true);
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .updateTable('core.dataset')
        .set({ data_version: 2 })
        .where('canonical_entity', '=', 'invoice')
        .execute(),
    );
    expect((await run('ownerA', plan())).cache_hit).toBe(false);
    expect((await run('ownerA', plan())).cache_hit).toBe(true);
  });

  it('a different day is a different key (overdue and similar figures depend on today)', async () => {
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const ctx = await f.db.tenantTx(f.A.tenantId, (tx) =>
      authz.load(tx, f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId),
    );
    const r = await executor.execute({
      tenantId: f.A.tenantId,
      userId: f.A.ownerUserId,
      requestId: 'cache-0002',
      scopeHash: ctx.authz_scope_hash,
      modelVersion: 1,
      plan: plan(),
      now: tomorrow,
    });
    expect(r.cache_hit).toBe(false);
  });

  it('a hit never skips the authorization re-check', async () => {
    await run('viewerA', plan()); // warm the cache for this scope at the current data version
    expect((await run('viewerA', plan())).cache_hit).toBe(true);
    await expect(run('viewerA', plan(), 'a'.repeat(64))).rejects.toBeInstanceOf(ContextRejected);
    await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .updateTable('core.tenant_membership')
        .set({ status: 'suspended' })
        .where('id', '=', f.A.viewerMembershipId)
        .execute(),
    );
    await expect(run('viewerA', plan())).rejects.toBeInstanceOf(ContextRejected);
  });

  it('results from a live (federated) source are never cached', async () => {
    const live = randomUUID();
    await f.db.tenantTx(f.B.tenantId, async (tx) => {
      await tx
        .insertInto('core.data_source')
        .values({
          id: live,
          tenant_id: f.B.tenantId,
          name: 'Live ERP',
          type: 'postgresql',
          access_mode: 'live_federated',
          connection: '{}',
          status: 'connected',
        })
        .execute();
      await tx
        .insertInto('core.dataset')
        .values({
          tenant_id: f.B.tenantId,
          data_source_id: live,
          canonical_entity: 'payment',
          data_version: 1,
          status: 'fresh',
          last_successful_sync_at: NOW,
        })
        .execute();
    });
    const p = plan({
      measures: ['payments_received'],
      dimensions: [],
      time_range: { start: '2026-04-01', end: '2026-11-15' },
    });
    expect((await run('ownerB', p)).cache_hit).toBe(false);
    expect((await run('ownerB', p)).cache_hit).toBe(false);
  });

  it('an unreachable cache is only a miss: the question is still answered', async () => {
    const broken = new PlanExecutor(
      f.db,
      authz,
      new AuditService(),
      new RedisResultCache('redis://127.0.0.1:1', 'x'),
      { RESULT_CACHE_TTL_SECONDS: 120 },
    );
    const ctx = await f.db.tenantTx(f.A.tenantId, (tx) =>
      authz.load(tx, f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId),
    );
    const r = await broken.execute({
      tenantId: f.A.tenantId,
      userId: f.A.ownerUserId,
      requestId: 'cache-0003',
      scopeHash: ctx.authz_scope_hash,
      modelVersion: 1,
      plan: plan({ time_range: { start: '2026-05-01', end: '2026-05-31' } }),
      now: NOW,
    });
    expect(r.cache_hit).toBe(false);
    expect(r.result_sets[0]?.rows.length).toBeGreaterThan(0);
  });
});
