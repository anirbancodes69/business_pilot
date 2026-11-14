import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../src/authorization/authorization';
import { evaluatePolicy } from '../src/authorization/policy-evaluator';
import { buildAuthorizedView } from '../src/configuration/authorized-view';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../src/configuration/templates/wholesale-distribution';

// The planner evaluation in ai-engine runs against these authorized views (one per persona). They
// are generated from the real builder, and this test fails when they drift from it. To regenerate:
//   UPDATE_FIXTURES=1 pnpm --filter @businesspilot/api test golden-view-fixtures

const dir = resolve(__dirname, '../../ai-engine/evaluation/fixtures');
const model = wholesaleDistributionTemplate();

function view(roles: string[], attributes: Record<string, unknown>) {
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
}

const personas = {
  owner: view(['owner'], {}),
  sales_manager_pune: view(['sales_manager'], { assigned_branch_ids: ['pune'] }),
};

describe('authorized view fixtures for the planner evaluation', () => {
  for (const [name, v] of Object.entries(personas)) {
    it(`${name} matches the builder`, () => {
      const file = resolve(dir, `view_${name}.json`);
      const text = `${JSON.stringify(v, null, 1)}\n`;
      if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, text);
      expect(existsSync(file), `${file} is missing: run with UPDATE_FIXTURES=1`).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
    });
  }

  it('the sales persona cannot even name receivables or payments', () => {
    const ids = personas.sales_manager_pune.measures.map((m) => m.id);
    expect(ids).toContain('revenue');
    expect(ids).not.toContain('outstanding_receivables');
    expect(ids).not.toContain('payments_received');
  });
});
