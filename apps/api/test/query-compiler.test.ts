import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../src/authorization/authorization';
import { evaluatePolicy } from '../src/authorization/policy-evaluator';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../src/configuration/templates/wholesale-distribution';
import { PlanRejected, compilePlan } from '../src/query/compiler';
import { type QueryPlan, queryPlanShape } from '../src/query/query-plan';

const model = wholesaleDistributionTemplate();
const policy = wholesaleDistributionPolicy();
const TENANT = '11111111-1111-4111-8111-111111111111';
const ctxFor = (
  roles: string[],
  attributes: Record<string, unknown> = {},
  masks: { entity: string; attribute: string; mask: 'hide' }[] = [],
) => {
  const e = evaluatePolicy({ policy, model, roles, userId: 'u1', attributes });
  return buildAuthorizationContext({
    tenantId: TENANT,
    userId: 'u1',
    roles,
    permissions: e.permissions,
    rowFilters: e.rowFilters,
    columnMasks: [...e.columnMasks, ...masks],
  });
};
const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  plan_version: '0.1',
  semantic_model_version: 1,
  intent: 'ranking',
  measures: ['outstanding_receivables'],
  dimensions: [{ id: 'customer.name' }],
  time_range: { start: '2026-04-01', end: '2026-09-30' },
  sort: [{ by: 'outstanding_receivables', direction: 'desc' }],
  limit: 10,
  ...over,
});
const compile = (p: QueryPlan, ctx = ctxFor(['owner']), asOf = '2026-11-14') =>
  compilePlan({ plan: p, model, ctx, asOf });
const rejection = (fn: () => unknown): PlanRejected | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlanRejected) return e;
    throw e;
  }
  return undefined;
};

describe('plan compiler', () => {
  it('compiles the headline question to parameterized SQL', () => {
    const [c] = compile(plan());
    expect(c?.sql).toContain('FROM "analytics"."invoice" b');
    expect(c?.sql).toContain('LEFT JOIN "analytics"."customer" j_customer');
    expect(c?.sql).toContain('b.tenant_id = $');
    expect(c?.sql).toContain('b.deleted_at IS NULL');
    expect(c?.sql).toContain('LIMIT 11');
    expect(c?.sql).toContain('GROUP BY 1');
    expect(c?.sql).toMatch(/ORDER BY 2 DESC NULLS LAST, 1 ASC/);
    expect(c?.params).toContain(TENANT);
    expect(c?.limit).toBe(10);
  });

  it('never puts a plan value in the SQL text', () => {
    const evil = "x'; DROP TABLE analytics.invoice; --";
    const [c] = compile(
      plan({ filters: [{ dimension: 'customer.name', operator: 'in', values: [evil, 'b'] }] }),
    );
    expect(c?.sql).not.toContain('DROP');
    expect(c?.sql).not.toContain(evil);
    expect(c?.params.some((p) => Array.isArray(p) && p.includes(evil))).toBe(true);
  });

  it('refuses relative time ranges, reversed ranges and old model versions', () => {
    expect(rejection(() => compile(plan({ time_range: { relative: 'last_month' } })))?.kind).toBe(
      'invalid',
    );
    expect(
      rejection(() => compile(plan({ time_range: { start: '2026-05-01', end: '2026-04-01' } })))
        ?.kind,
    ).toBe('invalid');
    expect(rejection(() => compile(plan({ semantic_model_version: 2 })))?.kind).toBe('invalid');
  });

  it('refuses breakdowns and measures of different entities', () => {
    expect(rejection(() => compile(plan({ breakdowns: ['branch.name'] })))?.kind).toBe('invalid');
    expect(rejection(() => compile(plan({ measures: ['revenue', 'units_sold'] })))?.kind).toBe(
      'invalid',
    );
  });

  it('forbids what is not in the user’s authorized view, and does not distinguish unknown ids', () => {
    const viewer = ctxFor(['viewer']);
    expect(rejection(() => compile(plan(), viewer))?.kind).toBe('forbidden');
    expect(rejection(() => compile(plan({ measures: ['no_such_measure'] })))?.kind).toBe(
      'forbidden',
    );
    const sales = ctxFor(['sales_manager'], { assigned_branch_ids: ['b1'] });
    const r = rejection(() =>
      compile(plan({ measures: ['payments_received'], dimensions: [] }), sales),
    );
    expect(r?.kind).toBe('forbidden');
  });

  it('applies the branch restriction of a sales manager, through an inner join', () => {
    const sales = ctxFor(['sales_manager'], { assigned_branch_ids: ['b2', 'b1'] });
    const [c] = compile(plan({ measures: ['revenue'], sort: [] }), sales);
    expect(c?.sql).toContain('INNER JOIN "analytics"."branch" j_branch');
    expect(c?.sql).toContain('j_branch."id"::text = ANY(');
    expect(c?.params).toContainEqual(['b1', 'b2']);
  });

  it('a restriction with no values matches no rows (fail closed)', () => {
    const sales = ctxFor(['sales_manager'], {});
    const [c] = compile(plan({ measures: ['revenue'], sort: [] }), sales);
    expect(c?.sql).toContain('WHERE b.tenant_id = $');
    expect(c?.sql).toContain('AND FALSE');
  });

  it('refuses a query that cannot carry the user’s row restriction', () => {
    const e = evaluatePolicy({ policy, model, roles: ['owner'], userId: 'u', attributes: {} });
    const ctx = buildAuthorizationContext({
      tenantId: TENANT,
      userId: 'u',
      roles: ['owner'],
      permissions: e.permissions,
      // A restriction on an entity that no join path from the measure reaches.
      rowFilters: [{ entity: 'product', attribute: 'id', operator: 'in', values: ['p1'] }],
    });
    const r = rejection(() =>
      compile(plan({ measures: ['payments_received'], dimensions: [] }), ctx),
    );
    expect(r?.kind).toBe('forbidden');
  });

  it('a column mask hides the measures and dimensions built on that column', () => {
    const ctx = ctxFor(['owner'], {}, [
      { entity: 'invoice_line', attribute: 'cost_amount', mask: 'hide' },
    ]);
    const r = rejection(() =>
      compile(plan({ measures: ['gross_margin'], dimensions: [], sort: [] }), ctx),
    );
    expect(r?.kind).toBe('forbidden');
    const r2 = rejection(() =>
      compile(plan({ measures: ['gross_margin_pct'], dimensions: [], sort: [] }), ctx),
    );
    expect(r2?.kind).toBe('forbidden');
  });

  it('compiles ratios, grains, comparison periods and the overdue rule', () => {
    const [cur, cmp] = compile(
      plan({
        measures: ['average_order_value'],
        dimensions: [{ id: 'invoice.invoice_date', time_grain: 'fiscal_quarter' }],
        sort: [],
        comparison: { type: 'custom', time_range: { start: '2025-04-01', end: '2025-09-30' } },
      }),
    );
    expect(cur?.sql).toContain('NULLIF(COUNT(*), 0)');
    expect(cur?.sql).toContain("date_trunc('quarter'");
    expect(cur?.sql).toContain('make_interval(months => 3)');
    expect(cmp?.role).toBe('comparison');
    expect(cmp?.params).toContain('2025-04-01');
    const [od] = compile(plan({ measures: ['overdue_receivables'], dimensions: [], sort: [] }));
    expect(od?.params).toContain('2026-11-14');
    expect(od?.sql).toContain('b.due_date <');
  });

  it('checks filter value types and operators', () => {
    const bad = (f: QueryPlan['filters']) => rejection(() => compile(plan({ filters: f })))?.kind;
    expect(bad([{ dimension: 'customer.name', operator: 'gt', values: ['a'] }])).toBe('invalid');
    expect(
      bad([{ dimension: 'invoice.invoice_date', operator: 'eq', values: ['yesterday'] }]),
    ).toBe('invalid');
    expect(
      bad([{ dimension: 'invoice.invoice_date', operator: 'between', values: ['2026-04-01'] }]),
    ).toBe('invalid');
    expect(
      bad([
        {
          dimension: 'invoice.invoice_date',
          operator: 'between',
          values: ['2026-04-01', '2026-04-30'],
        },
      ]),
    ).toBeUndefined();
  });

  it('the validator and the JSON contract name the same properties', () => {
    const schema = JSON.parse(
      readFileSync(resolve(__dirname, '../../../contracts/ai/query-plan.schema.json'), 'utf8'),
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(queryPlanShape).sort()).toEqual(Object.keys(schema.properties).sort());
  });
});
