import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../src/authorization/authorization';
import { evaluatePolicy } from '../src/authorization/policy-evaluator';
import { buildAuthorizedView } from '../src/configuration/authorized-view';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../src/configuration/templates/wholesale-distribution';

const model = wholesaleDistributionTemplate();
const policy = wholesaleDistributionPolicy();
const ctxFor = (roles: string[], attributes: Record<string, unknown> = {}) => {
  const e = evaluatePolicy({ policy, model, roles, userId: 'u1', attributes });
  return buildAuthorizationContext({
    tenantId: 't',
    userId: 'u1',
    roles,
    permissions: e.permissions,
    rowFilters: e.rowFilters,
    columnMasks: e.columnMasks,
  });
};

describe('policy evaluation (default deny)', () => {
  it('a role without a grant gets nothing', () => {
    const ctx = ctxFor(['viewer']);
    expect(ctx.granted).toEqual({ entities: [], measures: [], dimensions: [] });
    expect(buildAuthorizedView(model, ctx).measures).toEqual([]);
  });

  it('owner gets everything in the published model', () => {
    const ctx = ctxFor(['owner']);
    expect(ctx.granted.measures).toHaveLength(model.measures.length);
    expect(ctx.row_filters).toEqual([]);
  });

  it('a sales manager gets only their assigned branches, resolved into the context', () => {
    const ctx = ctxFor(['sales_manager'], { assigned_branch_ids: ['b2', 'b1'] });
    expect(ctx.row_filters).toEqual([
      { entity: 'branch', attribute: 'id', operator: 'in', values: ['b1', 'b2'] },
    ]);
  });

  it('a row rule with a missing attribute fails closed (empty list, not no filter)', () => {
    expect(ctxFor(['sales_manager'], {}).row_filters).toEqual([
      { entity: 'branch', attribute: 'id', operator: 'in', values: [] },
    ]);
    expect(
      ctxFor(['sales_manager'], { assigned_branch_ids: 'nope' }).row_filters[0]?.values,
    ).toEqual(['nope']);
  });

  it('the scope hash differs between branches, roles and masks', () => {
    const a = ctxFor(['sales_manager'], { assigned_branch_ids: ['b1'] }).authz_scope_hash;
    const b = ctxFor(['sales_manager'], { assigned_branch_ids: ['b2'] }).authz_scope_hash;
    const c = ctxFor(['finance_manager']).authz_scope_hash;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('authorized view', () => {
  const view = buildAuthorizedView(
    model,
    ctxFor(['sales_manager'], { assigned_branch_ids: ['b1'] }),
  );

  it('contains only granted items, and ratios only when both parts are visible', () => {
    const ids = view.measures.map((m) => m.id);
    expect(ids).toContain('revenue');
    expect(ids).toContain('average_selling_price'); // line_revenue and units_sold are granted
    expect(ids).not.toContain('gross_margin');
    expect(ids).not.toContain('gross_margin_pct');
    expect(ids).not.toContain('outstanding_receivables');
    expect(view.entities.map((e) => e.id)).not.toContain('payment');
    expect(view.dimensions.map((d) => d.id)).not.toContain('invoice.due_date');
  });

  it('drops a ratio when one part is not granted', () => {
    const e = evaluatePolicy({
      policy,
      model,
      roles: ['sales_manager'],
      userId: 'u',
      attributes: {},
    });
    const ctx = buildAuthorizationContext({
      tenantId: 't',
      userId: 'u',
      roles: [],
      permissions: e.permissions.filter((p) => p !== 'measure:units_sold:read'),
    });
    expect(buildAuthorizedView(model, ctx).measures.map((m) => m.id)).not.toContain(
      'average_selling_price',
    );
  });

  it('filters valid_dimensions, drivers and the glossary to what is visible', () => {
    const lr = view.measures.find((m) => m.id === 'line_revenue');
    expect(lr?.valid_dimensions).toContain('product.category');
    expect(lr?.valid_dimensions).not.toContain('invoice.due_date');
    const glossary = view.glossary.map((g) => g.term);
    expect(glossary).toContain('sales');
    expect(glossary).not.toContain('dues');
    expect(glossary).not.toContain('profit');
  });

  it('a column mask hides measures and dimensions built on that column', () => {
    const ctx = buildAuthorizationContext({
      ...{ tenantId: 't', userId: 'u', roles: [] },
      permissions: ctxFor(['owner']).permissions,
      columnMasks: [
        { entity: 'invoice', attribute: 'net_amount', mask: 'hide' },
        { entity: 'branch', attribute: 'name', mask: 'redact' },
      ],
    });
    const v = buildAuthorizedView(model, ctx);
    expect(v.measures.map((m) => m.id)).not.toContain('revenue');
    expect(v.measures.map((m) => m.id)).not.toContain('average_order_value');
    expect(v.dimensions.map((d) => d.id)).not.toContain('branch.name');
  });

  it('never exposes physical names, expressions, formulas, row filters or member names', () => {
    for (const roles of [['owner'], ['sales_manager']]) {
      const json = JSON.stringify(
        buildAuthorizedView(model, ctxFor(roles, { assigned_branch_ids: ['SECRET-BRANCH-ID'] })),
      );
      for (const forbidden of [
        'analytics.',
        'net_amount',
        'cost_amount',
        'expression_ref',
        'formula_ref',
        'price_volume',
        'row_filters',
        'SECRET-BRANCH-ID',
        'member_synonyms',
        '"table"',
        '"attribute"',
      ])
        expect(json, forbidden).not.toContain(forbidden);
    }
  });
});
