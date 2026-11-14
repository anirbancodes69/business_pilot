import { describe, expect, it } from 'vitest';
import { wholesaleDistributionTemplate } from '../src/configuration/templates/wholesale-distribution';
import { MemoryResultCache, cacheKey } from '../src/platform/cache/result-cache';
import { normalizePlan, touchesSensitiveFields } from '../src/query/plan-executor';
import type { QueryPlan } from '../src/query/query-plan';

const T = '11111111-1111-4111-8111-111111111111';
const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  plan_version: '0.1',
  semantic_model_version: 1,
  intent: 'ranking',
  measures: ['revenue', 'invoice_count'],
  dimensions: [{ id: 'customer.name' }],
  filters: [{ dimension: 'branch.name', operator: 'in', values: ['Pune', 'Nashik'] }],
  time_range: { start: '2026-10-01', end: '2026-10-31' },
  ...over,
});

describe('exact result cache (unit)', () => {
  it('equivalent plans normalise to the same form, different plans do not', () => {
    const reordered = plan({
      measures: ['invoice_count', 'revenue'],
      filters: [{ dimension: 'branch.name', operator: 'in', values: ['Nashik', 'Pune'] }],
      rationale: 'a different explanation',
    });
    expect(JSON.stringify(normalizePlan(reordered))).toBe(JSON.stringify(normalizePlan(plan())));
    const other = plan({ time_range: { start: '2026-09-01', end: '2026-09-30' } });
    expect(JSON.stringify(normalizePlan(other))).not.toBe(JSON.stringify(normalizePlan(plan())));
  });

  it('keys always carry the tenant id, and refuse anything that is not one', () => {
    expect(cacheKey(T, 'abc')).toBe(`t:${T}:qc:abc`);
    expect(() => cacheKey('not-a-tenant', 'abc')).toThrow();
    expect(() => cacheKey('*', 'abc')).toThrow();
  });

  it('the in-memory store expires entries and keeps tenants apart', async () => {
    let now = 1_000;
    const c = new MemoryResultCache(() => now);
    const other = '22222222-2222-4222-8222-222222222222';
    await c.set(T, 'h', 'v', 10);
    expect(await c.get(T, 'h')).toBe('v');
    expect(await c.get(other, 'h')).toBeUndefined();
    now += 11_000;
    expect(await c.get(T, 'h')).toBeUndefined();
  });

  it('plans touching fields tagged pii or sensitive are never cached', () => {
    const model = wholesaleDistributionTemplate();
    expect(touchesSensitiveFields(model, plan())).toBe(false);
    const flagged = wholesaleDistributionTemplate();
    const dim = flagged.dimensions.find((d) => d.id === 'customer.name');
    if (dim) dim.tags = ['pii'];
    expect(touchesSensitiveFields(flagged, plan())).toBe(true);
    // a filter on a flagged dimension counts too, and so does a flagged part of a ratio
    expect(
      touchesSensitiveFields(
        flagged,
        plan({
          dimensions: [],
          filters: [{ dimension: 'customer.name', operator: 'eq', values: ['x'] }],
        }),
      ),
    ).toBe(true);
    const ratio = wholesaleDistributionTemplate();
    const num = ratio.measures.find((m) => m.id === 'gross_margin');
    if (num) num.tags = ['sensitive'];
    expect(
      touchesSensitiveFields(
        ratio,
        plan({ measures: ['gross_margin_pct'], dimensions: [], filters: [] }),
      ),
    ).toBe(true);
  });
});
