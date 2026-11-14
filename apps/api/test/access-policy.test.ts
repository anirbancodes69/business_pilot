import { describe, expect, it } from 'vitest';
import {
  type PolicyRefs,
  RESTRICTED_POLICY_PERMISSIONS,
  validateAccessPolicy,
} from '../src/authorization/access-policy.validator';
import { evaluatePolicy } from '../src/authorization/policy-evaluator';
import { entityColumns } from '../src/configuration/entity-columns';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../src/configuration/templates/wholesale-distribution';
import { PERMISSIONS, SYSTEM_ROLES } from '../src/migrations/0002_system_roles';

const model = wholesaleDistributionTemplate();
const refs: PolicyRefs = {
  model,
  roleKeys: Object.keys(SYSTEM_ROLES),
  permissionKeys: Object.keys(PERMISSIONS),
  entityColumns: entityColumns(model),
};
const policy = (over: Record<string, unknown>) => ({ policy_version: 1, role_grants: [], ...over });

describe('access policy validation', () => {
  it('accepts the template policy', () => {
    expect(validateAccessPolicy(wholesaleDistributionPolicy(), refs).problems).toEqual([]);
  });

  it('accepts a catalog permission that is not restricted', () => {
    const p = policy({ role_grants: [{ role: 'finance_manager', permissions: ['audit:read'] }] });
    expect(validateAccessPolicy(p, refs).problems).toEqual([]);
  });

  it.each(RESTRICTED_POLICY_PERMISSIONS)('refuses to grant %s', (permission) => {
    const p = policy({ role_grants: [{ role: 'viewer', permissions: [permission] }] });
    expect(validateAccessPolicy(p, refs).problems).toEqual([
      `viewer: permission ${permission} cannot be granted by a policy`,
    ]);
  });

  it('refuses permissions that are not in the catalog, and hand-written data grants', () => {
    const p = policy({
      role_grants: [
        { role: 'viewer', permissions: ['not_a_real:permission', 'measure:revenue:read'] },
      ],
    });
    expect(validateAccessPolicy(p, refs).problems).toEqual([
      'viewer: unknown permission not_a_real:permission',
      'viewer: grant data through entities, measures or dimensions',
    ]);
  });

  it('refuses a mask or a row rule on a column that does not exist (it would protect nothing)', () => {
    const p = policy({
      column_rules: [{ entity: 'customer', attribute: 'gstinn', mask: 'hide' }],
      row_rules: [
        {
          applies_to_roles: ['sales_manager'],
          entity: 'invoice',
          attribute: 'no_such_column',
          operator: 'in',
          user_attribute: 'assigned_branch_ids',
        },
        {
          applies_to_roles: ['sales_manager'],
          entity: 'ghost',
          attribute: 'id',
          operator: 'in',
          user_attribute: 'assigned_branch_ids',
        },
      ],
    });
    expect(validateAccessPolicy(p, refs).problems).toEqual([
      'row rule: unknown attribute invoice.no_such_column',
      'row rule: unknown entity ghost',
      'column rule: unknown attribute customer.gstinn',
    ]);
  });
});

describe('policy evaluation does not trust a stored policy', () => {
  it('drops restricted permissions and hand-written data grants, keeps ordinary ones', () => {
    const stored = validateAccessPolicy(
      policy({
        role_grants: [
          {
            role: 'viewer',
            permissions: [...RESTRICTED_POLICY_PERMISSIONS, 'entity:customer:read', 'audit:read'],
          },
        ],
      }),
    ).policy;
    if (!stored) throw new Error('structurally valid policy expected');
    const effect = evaluatePolicy({
      policy: stored,
      model,
      roles: ['viewer'],
      userId: 'u',
      attributes: {},
    });
    expect(effect.permissions).toEqual(['audit:read']);
  });
});

describe('entity columns', () => {
  it('knows catalog columns, the surrogate key and columns the model names', () => {
    const columns = entityColumns(model);
    expect(columns.get('customer')?.has('gstin')).toBe(true);
    expect(columns.get('branch')?.has('id')).toBe(true);
    expect(columns.get('invoice')?.has('branch_id')).toBe(true);
    expect(columns.get('customer')?.has('gstinn')).toBe(false);
  });
});
