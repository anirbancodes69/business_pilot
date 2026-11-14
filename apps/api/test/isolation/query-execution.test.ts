import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../../src/configuration/templates/wholesale-distribution';
import { rawRows } from '../../src/platform/database/tenant-tx';
import { PlanRejected } from '../../src/query/compiler';
import { ContextRejected, PlanExecutor } from '../../src/query/plan-executor';
import type { QueryPlan } from '../../src/query/query-plan';
import { createFixture, type Fixture } from './harness';

// E6.3: the plan compiler and executor against real PostgreSQL. Tenant A and B hold the same
// customer name; a sales manager is limited to branch b1; soft-deleted rows never count.

let f: Fixture;
let executor: PlanExecutor;
const authz = new AuthorizationService();
const NOW = new Date('2026-11-14T06:00:00Z');
const id = { b1: randomUUID(), b2: randomUUID() };

beforeAll(async () => {
  f = await createFixture();
  executor = new PlanExecutor(f.db, authz, new AuditService());
  const model = wholesaleDistributionTemplate();
  const policy = wholesaleDistributionPolicy();
  const ds = randomUUID();

  for (const [tenantId, big] of [
    [f.A.tenantId, false],
    [f.B.tenantId, true],
  ] as const) {
    await f.db.tenantTx(tenantId, async (tx) => {
      await tx
        .insertInto('core.semantic_model')
        .values({
          tenant_id: tenantId,
          version: 1,
          status: 'published',
          document: JSON.stringify(model),
        })
        .execute();
      await tx
        .insertInto('core.access_policy')
        .values({
          tenant_id: tenantId,
          version: 1,
          status: 'active',
          document: JSON.stringify(policy),
        })
        .execute();
      const row = (table: string, cols: Record<string, unknown>, deleted = false) => {
        const keys = Object.keys(cols);
        return sql`insert into ${sql.table(`analytics.${table}`)}
          (tenant_id, data_source_id, source_key, deleted_at, ${sql.join(keys.map((k) => sql.ref(k)))})
          values (${tenantId}, ${ds}, ${randomUUID()}, ${deleted ? sql`now()` : null},
                  ${sql.join(keys.map((k) => cols[k]))})`.execute(tx);
      };
      const b1 = tenantId === f.A.tenantId ? id.b1 : randomUUID();
      const b2 = tenantId === f.A.tenantId ? id.b2 : randomUUID();
      await row('branch', { id: b1, name: 'Pune', state: 'MH' });
      await row('branch', { id: b2, name: 'Nashik', state: 'MH' });
      const c1 = randomUUID();
      const c2 = randomUUID();
      await row('customer', { id: c1, name: 'Asha Traders', branch_id: b1 });
      await row('customer', { id: c2, name: 'Vikram Stores', branch_id: b2 });
      const inv = (
        cust: string,
        br: string,
        date: string,
        due: string,
        net: number,
        del = false,
      ) => {
        const i = randomUUID();
        return row(
          'invoice',
          {
            id: i,
            customer_id: cust,
            branch_id: br,
            invoice_date: date,
            due_date: due,
            net_amount: net,
          },
          del,
        ).then(() => i);
      };
      const mult = big ? 100 : 1;
      const i1 = await inv(c1, b1, '2026-04-10', '2026-05-10', 1000 * mult);
      await inv(c2, b2, '2026-04-12', '2026-05-12', 500 * mult);
      await inv(c1, b1, '2026-10-01', '2026-11-30', 200 * mult);
      await inv(c1, b1, '2026-04-20', '2026-05-20', 9999, true); // soft-deleted: never counted
      const p = randomUUID();
      await row('payment', {
        id: p,
        customer_id: c1,
        payment_date: '2026-05-01',
        amount: 300 * mult,
      });
      await row('payment_allocation', { payment_id: p, invoice_id: i1, amount: 300 * mult });
    });
  }

  // Viewer of tenant A becomes a sales manager limited to branch b1.
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
      .set({ attributes: JSON.stringify({ assigned_branch_ids: [id.b1] }) })
      .where('id', '=', f.A.viewerMembershipId)
      .execute();
  });
});
afterAll(async () => {
  await f.close();
});

const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  plan_version: '0.1',
  semantic_model_version: 1,
  intent: 'ranking',
  measures: ['outstanding_receivables'],
  dimensions: [{ id: 'customer.name' }],
  time_range: { start: '2026-04-01', end: '2026-11-30' },
  sort: [{ by: 'outstanding_receivables', direction: 'desc' }],
  ...over,
});

async function run(who: 'ownerA' | 'viewerA' | 'ownerB', p: QueryPlan, scopeHash?: string) {
  const [tenantId, userId, membershipId] =
    who === 'ownerA'
      ? [f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId]
      : who === 'viewerA'
        ? [f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId]
        : [f.B.tenantId, f.B.ownerUserId, f.B.ownerMembershipId];
  const ctx = await f.db.tenantTx(tenantId, (tx) => authz.load(tx, tenantId, userId, membershipId));
  return executor.execute({
    tenantId,
    userId,
    requestId: 'req-test-0001',
    scopeHash: scopeHash ?? ctx.authz_scope_hash,
    modelVersion: 1,
    plan: p,
    now: NOW,
  });
}
const num = (v: unknown) => Number(v);

describe('plan execution (E6.3)', () => {
  it('answers the headline question with correct figures', async () => {
    const r = await run('ownerA', plan());
    expect(r.result_sets[0]?.rows.map((x) => [x[0], num(x[1])])).toEqual([
      ['Asha Traders', 900], // 1000 - 300 allocated + 200, soft-deleted 9999 excluded
      ['Vikram Stores', 500],
    ]);
    expect(r.truncated).toBe(false);
  });

  it('tenant B sees only its own rows, from the same plan', async () => {
    const r = await run('ownerB', plan());
    expect(r.result_sets[0]?.rows.map((x) => num(x[1]))).toEqual([90000, 50000]);
  });

  it('overdue uses the business rule and the as-of date', async () => {
    const r = await run(
      'ownerA',
      plan({ measures: ['overdue_receivables'], dimensions: [], sort: [] }),
    );
    expect(num(r.result_sets[0]?.rows[0]?.[0])).toBe(1200); // 700 + 500, the 200 invoice is due later
  });

  it('a sales manager gets only the assigned branch, whatever the plan asks for', async () => {
    const own = await run('ownerA', plan({ measures: ['revenue'], sort: [] }));
    expect(own.result_sets[0]?.rows).toHaveLength(2);
    const mine = await run('viewerA', plan({ measures: ['revenue'], sort: [] }));
    expect(mine.result_sets[0]?.rows.map((x) => [x[0], num(x[1])])).toEqual([
      ['Asha Traders', 1200],
    ]);
    // asking for the other branch explicitly returns nothing, not the other branch
    const other = await run(
      'viewerA',
      plan({
        measures: ['revenue'],
        sort: [],
        filters: [{ dimension: 'branch.name', operator: 'eq', values: ['Nashik'] }],
      }),
    );
    expect(other.result_sets[0]?.rows).toEqual([]);
    // no dimensions: the total is the branch total only
    const total = await run('viewerA', plan({ measures: ['revenue'], dimensions: [], sort: [] }));
    expect(num(total.result_sets[0]?.rows[0]?.[0])).toBe(1200);
  });

  it('a sales manager cannot use a measure outside their grants', async () => {
    await expect(run('viewerA', plan())).rejects.toBeInstanceOf(PlanRejected);
  });

  it('runs time grains and comparison periods', async () => {
    const r = await run(
      'ownerA',
      plan({
        measures: ['revenue'],
        dimensions: [{ id: 'invoice.invoice_date', time_grain: 'month' }],
        sort: [],
        comparison: { type: 'custom', time_range: { start: '2025-04-01', end: '2025-11-30' } },
      }),
    );
    expect(r.result_sets.map((s) => s.role)).toEqual(['current', 'comparison']);
    expect(r.result_sets[0]?.rows.map((x) => num(x[1]))).toEqual([1500, 200]); // April, October
    expect(r.result_sets[1]?.rows).toEqual([]);
  });

  it('reports truncation instead of silently cutting rows', async () => {
    const r = await run('ownerA', plan({ limit: 1 }));
    expect(r.result_sets[0]?.rows).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('refuses a request whose authorization changed since the token was issued', async () => {
    await expect(run('ownerA', plan(), 'a'.repeat(64))).rejects.toBeInstanceOf(ContextRejected);
  });

  it('writes audit events with identifiers and counts, never rows or names', async () => {
    await run('ownerA', plan());
    await run('viewerA', plan()).catch(() => undefined);
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'metadata'])
        .where('action', 'in', ['query.executed', 'query.rejected'])
        .execute(),
    );
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['query.executed', 'query.rejected']),
    );
    expect(JSON.stringify(events)).not.toContain('Asha');
  });

  it('the execution transaction is read-only', async () => {
    await expect(
      f.db.tenantTx(
        f.A.tenantId,
        (tx) => rawRows(tx, 'update analytics.invoice set net_amount = 0', []),
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only/);
  });
});
