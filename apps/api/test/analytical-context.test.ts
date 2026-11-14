import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../src/authorization/authorization';
import { evaluatePolicy } from '../src/authorization/policy-evaluator';
import { buildAuthorizedView } from '../src/configuration/authorized-view';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../src/configuration/templates/wholesale-distribution';
import { analyticalContextSchema, revalidateContext } from '../src/question/analytical-context';
import { nowInZone } from '../src/question/question.service';

const model = wholesaleDistributionTemplate();
const viewFor = (roles: string[], attributes: Record<string, unknown> = {}) => {
  const e = evaluatePolicy({
    policy: wholesaleDistributionPolicy(),
    model,
    roles,
    userId: 'u',
    attributes,
  });
  return buildAuthorizedView(
    model,
    buildAuthorizationContext({
      tenantId: 't',
      userId: 'u',
      roles,
      permissions: e.permissions,
      rowFilters: e.rowFilters,
      columnMasks: e.columnMasks,
    }),
  );
};

const stored = {
  semantic_model_version: 1,
  turn: 2,
  focus: {
    metrics: ['outstanding_receivables', 'revenue'],
    dimensions: ['customer.name', 'branch.name'],
    filters: [{ dimension: 'customer.segment', operator: 'eq', values: ['retail'] }],
    time_range: { relative: 'last_month' },
  },
  last_analysis_type: 'ranking',
  evidence_refs: ['ev_0a1b2c3d'],
};

describe('analytical context (D-21)', () => {
  it('holds ids and tokens only: unknown keys such as rows or question text are refused', () => {
    expect(analyticalContextSchema.safeParse(stored).success).toBe(true);
    for (const extra of [{ rows: [[1]] }, { question: 'dues?' }, { figures: { total: 5 } }])
      expect(analyticalContextSchema.safeParse({ ...stored, ...extra }).success).toBe(false);
    expect(
      analyticalContextSchema.safeParse({ ...stored, evidence_refs: ['not-an-id'] }).success,
    ).toBe(false);
  });

  it('keeps everything the user can still see', () => {
    const { context, reset } = revalidateContext(stored, viewFor(['owner']));
    expect(reset).toBe(false);
    expect(context?.focus?.metrics).toEqual(['outstanding_receivables', 'revenue']);
  });

  it('drops what the user can no longer see, never the other way round', () => {
    const sales = viewFor(['sales_manager'], { assigned_branch_ids: ['b1'] });
    const { context } = revalidateContext(stored, sales);
    expect(context?.focus?.metrics).toEqual(['revenue']);
    expect(context?.focus?.dimensions).toEqual(['customer.name', 'branch.name']);
    const viewer = revalidateContext(stored, viewFor(['viewer'])).context;
    expect(viewer?.focus?.metrics).toEqual([]);
    expect(viewer?.focus?.dimensions).toEqual([]);
    expect(viewer?.focus?.filters).toEqual([]);
  });

  it('resets when the semantic model version changed or the stored value is damaged', () => {
    const v2 = { ...viewFor(['owner']), semantic_model_version: 2 };
    expect(revalidateContext(stored, v2)).toEqual({ context: undefined, reset: true });
    expect(revalidateContext({ nonsense: true }, viewFor(['owner'])).reset).toBe(true);
  });
});

describe('nowInZone', () => {
  it('renders local time with the zone offset', () => {
    const at = new Date('2026-11-14T22:00:00Z');
    expect(nowInZone('Asia/Kolkata', at)).toBe('2026-11-15T03:30:00+05:30');
    expect(nowInZone('UTC', at)).toBe('2026-11-14T22:00:00+00:00');
  });
});
