import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import { seedSynthetic } from '../../src/dev/seed-synthetic';
import { syntheticDistributor } from '../../src/dev/synthetic-distributor';
import { PlanRejected } from '../../src/query/compiler';
import { type ExecutionResult, PlanExecutor } from '../../src/query/plan-executor';
import type { QueryPlan } from '../../src/query/query-plan';
import { oracle } from '../golden/oracle';
import { createFixture, type Fixture } from './harness';

// E6.6, deterministic layer: every active golden case with an expected plan is executed through the
// real compiler and PostgreSQL, and compared with an independent oracle over the synthetic data. No
// model is called. The planner layer (question -> plan) is evaluated separately in ai-engine.

interface Case {
  id: string;
  status: 'active' | 'pending';
  expected: 'plan' | 'clarify' | 'out_of_scope';
  expected_intent?: QueryPlan['intent'];
  persona: 'owner' | 'sales_manager_pune';
  expected_api?: 'ok' | 'empty' | 'forbidden';
  restricted_to_branch?: string;
  expected_plan?: {
    measures: string[];
    dimensions?: {
      id: string;
      time_grain?: QueryPlan['dimensions'] extends (infer D)[] | undefined
        ? D extends { time_grain?: infer G }
          ? G
          : never
        : never;
    }[];
    filters?: { dimension: string; operator: 'eq'; values: string[] }[];
    time_range?: { start: string; end: string };
    comparison?: { start: string; end: string };
    sort?: { by: string; direction: 'asc' | 'desc' };
    limit?: number;
  };
}

const suite = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../ai-engine/evaluation/golden/wholesale_v0.json'),
    'utf8',
  ),
) as { cases: Case[] };
const NOW = new Date('2026-11-15T04:30:00Z'); // 10:00 in Asia/Kolkata
const AS_OF = '2026-11-15';
const NO_PERIOD = { start: '2024-11-16', end: '2026-11-15' }; // what "no period stated" means to the planner

let f: Fixture;
let executor: PlanExecutor;
const authz = new AuthorizationService();
const data = syntheticDistributor();
const pune = data.branch.find((b) => b.name === 'Pune')?.id as string;

beforeAll(async () => {
  f = await createFixture();
  executor = new PlanExecutor(f.db, authz, new AuditService());
  await f.db.tenantTx(f.A.tenantId, (tx) => seedSynthetic(tx, f.A.tenantId, data));
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
});
afterAll(async () => {
  await f.close();
});

function toPlan(c: Case): QueryPlan {
  const e = c.expected_plan as NonNullable<Case['expected_plan']>;
  return {
    plan_version: '0.1',
    semantic_model_version: 1,
    intent: c.expected_intent ?? 'metric',
    measures: e.measures,
    ...(e.dimensions ? { dimensions: e.dimensions } : {}),
    ...(e.filters ? { filters: e.filters } : {}),
    time_range: e.time_range ?? NO_PERIOD,
    ...(e.comparison ? { comparison: { type: 'custom' as const, time_range: e.comparison } } : {}),
    ...(e.sort ? { sort: [e.sort] } : {}),
    ...(e.limit ? { limit: e.limit } : {}),
  };
}

async function run(c: Case, plan: QueryPlan): Promise<ExecutionResult> {
  const [userId, membershipId] =
    c.persona === 'owner'
      ? [f.A.ownerUserId, f.A.ownerMembershipId]
      : [f.A.viewerUserId, f.A.viewerMembershipId];
  const ctx = await f.db.tenantTx(f.A.tenantId, (tx) =>
    authz.load(tx, f.A.tenantId, userId, membershipId),
  );
  return executor.execute({
    tenantId: f.A.tenantId,
    userId,
    requestId: 'golden-0001',
    scopeHash: ctx.authz_scope_hash,
    modelVersion: 1,
    plan,
    now: NOW,
  });
}

function rowsToMap(set: ExecutionResult['result_sets'][number]): Map<string, (number | null)[]> {
  const dims = set.columns.filter((c) => c.kind === 'dimension').length;
  return new Map(
    set.rows.map((r) => [
      r
        .slice(0, dims)
        .map((v) => String(v ?? ''))
        .join('|'),
      r.slice(dims).map((v) => (v === null ? null : Number(v))),
    ]),
  );
}

function close(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 1e-9);
}

function compare(
  c: Case,
  actual: Map<string, (number | null)[]>,
  plan: QueryPlan,
  range: { start: string; end: string },
): void {
  const expected = oracle(
    data,
    {
      ...plan,
      filters: plan.filters?.map((x) => ({ dimension: x.dimension, values: x.values.map(String) })),
      time_range: range,
    },
    {
      asOf: AS_OF,
      branchIds: c.persona === 'sales_manager_pune' ? [pune] : undefined,
    },
  );
  let want = [...expected];
  if (plan.limit) {
    const idx = plan.measures.indexOf(plan.sort?.[0]?.by ?? plan.measures[0] ?? '');
    want = want
      .sort((a, b) => (b[1][idx] ?? -Infinity) - (a[1][idx] ?? -Infinity) || (a[0] < b[0] ? -1 : 1))
      .slice(0, plan.limit);
  }
  if (!plan.dimensions?.length) {
    // An aggregate over no rows is NULL in SQL; the oracle reports the same.
  }
  expect([...actual.keys()].sort(), `${c.id}: groups`).toEqual(want.map(([k]) => k).sort());
  for (const [k, values] of want) {
    const got = actual.get(k) as (number | null)[];
    values.forEach((v, i) =>
      expect(
        close(got[i] ?? null, v),
        `${c.id} [${k}] measure ${i}: got ${got[i]}, want ${v}`,
      ).toBe(true),
    );
  }
}

const active = suite.cases.filter((c) => c.status === 'active' && c.expected === 'plan');

describe('golden set, execution accuracy (no model)', () => {
  it('has a meaningful number of active cases', () => {
    expect(active.length).toBeGreaterThanOrEqual(35);
  });

  for (const c of active) {
    it(`${c.id}: ${c.expected_api === 'forbidden' ? 'is refused' : 'matches the oracle'}`, async () => {
      const plan = toPlan(c);
      if (c.expected_api === 'forbidden') {
        await expect(run(c, plan)).rejects.toSatisfy(
          (e: unknown) => e instanceof PlanRejected && e.kind === 'forbidden',
        );
        return;
      }
      const result = await run(c, plan);
      const [current, comparison] = result.result_sets;
      if (c.expected_api === 'empty') {
        expect(
          current?.rows.filter((r) =>
            r.slice(-plan.measures.length).some((v) => v !== null && Number(v) !== 0),
          ),
        ).toEqual([]);
        return;
      }
      compare(
        c,
        rowsToMap(current as NonNullable<typeof current>),
        plan,
        plan.time_range as { start: string; end: string },
      );
      if (plan.comparison)
        compare(
          c,
          rowsToMap(comparison as NonNullable<typeof comparison>),
          plan,
          plan.comparison.time_range as { start: string; end: string },
        );
      if (c.restricted_to_branch) {
        const names = [...rowsToMap(current as NonNullable<typeof current>).keys()];
        expect(names).toEqual([c.restricted_to_branch]);
      }
    });
  }

  it('returns calendar days as plain YYYY-MM-DD text', async () => {
    const trend = active.find((c) => c.id === 'trd-001') as Case;
    const result = await run(trend, toPlan(trend));
    for (const row of result.result_sets[0]?.rows ?? [])
      expect(String(row[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
