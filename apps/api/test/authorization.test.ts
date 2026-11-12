import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationContext,
  canonicalJson,
  hasPermission,
} from '../src/authorization/authorization';

const base = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
};

describe('authorization context', () => {
  it('denies by default: no roles means no permissions and no data grants', () => {
    const ctx = buildAuthorizationContext({ ...base, roles: [], permissions: [] });
    expect(ctx.permissions).toEqual([]);
    expect(ctx.granted).toEqual({ entities: [], measures: [], dimensions: [] });
    expect(hasPermission(ctx, 'user:manage')).toBe(false);
  });

  it('derives data grants from permission names', () => {
    const ctx = buildAuthorizationContext({
      ...base,
      roles: ['finance_manager'],
      permissions: [
        'entity:invoice:read',
        'measure:revenue:read',
        'dimension:branch.name:read',
        'tenant:read',
      ],
    });
    expect(ctx.granted).toEqual({
      entities: ['invoice'],
      measures: ['revenue'],
      dimensions: ['branch.name'],
    });
  });

  it('scope hash is stable regardless of input order', () => {
    const a = buildAuthorizationContext({
      ...base,
      roles: ['a', 'b'],
      permissions: ['measure:x:read', 'measure:y:read'],
    });
    const b = buildAuthorizationContext({
      ...base,
      roles: ['b', 'a'],
      permissions: ['measure:y:read', 'measure:x:read'],
    });
    expect(a.authz_scope_hash).toBe(b.authz_scope_hash);
    expect(a.authz_scope_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('scope hash changes when the data scope, a row filter or the policy version changes', () => {
    const hash = (o: Partial<Parameters<typeof buildAuthorizationContext>[0]>) =>
      buildAuthorizationContext({ ...base, roles: [], permissions: ['measure:x:read'], ...o })
        .authz_scope_hash;
    const ref = hash({});
    expect(hash({ permissions: ['measure:x:read', 'measure:y:read'] })).not.toBe(ref);
    expect(
      hash({
        rowFilters: [{ entity: 'invoice', attribute: 'branch_id', operator: 'in', values: ['b1'] }],
      }),
    ).not.toBe(ref);
    expect(hash({ policyVersion: 2 })).not.toBe(ref);
  });

  it('two users with the same scope in different tenants share a hash (tenant is keyed separately in caches)', () => {
    const a = buildAuthorizationContext({ ...base, roles: [], permissions: ['measure:x:read'] });
    const b = buildAuthorizationContext({
      ...base,
      tenantId: '33333333-3333-4333-8333-333333333333',
      roles: [],
      permissions: ['measure:x:read'],
    });
    expect(a.authz_scope_hash).toBe(b.authz_scope_hash);
  });

  it('canonicalJson sorts keys', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
