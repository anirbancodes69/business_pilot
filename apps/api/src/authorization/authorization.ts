import { createHash } from 'node:crypto';

// Mirrors contracts/tenant/authorization-context.schema.json (internal to the api, never sent to ai-engine).
export interface AuthorizationContext {
  tenant_id: string;
  user_id: string;
  roles: string[];
  permissions: string[];
  granted: { entities: string[]; measures: string[]; dimensions: string[] };
  row_filters: {
    entity: string;
    attribute: string;
    operator: 'eq' | 'in';
    values: (string | number)[];
  }[];
  column_masks: { entity: string; attribute: string; mask: 'hide' | 'redact' | 'hash' }[];
  policy_version: number;
  authz_scope_hash: string;
}

/** Deterministic JSON: object keys sorted, arrays kept in order (callers sort what is a set). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Data grants are permissions named entity:<id>:read, measure:<id>:read and dimension:<id>:read. */
function grantedOf(permissions: string[], kind: 'entity' | 'measure' | 'dimension'): string[] {
  const re = new RegExp(`^${kind}:([a-z0-9_.]+):read$`);
  return sorted(permissions.flatMap((p) => re.exec(p)?.[1] ?? []));
}

/**
 * Default deny: the context contains only what the user's roles grant. Row filters (ABAC) are added
 * with the semantic model in Milestone 3. `authz_scope_hash` covers the data scope and policy version.
 */
export function buildAuthorizationContext(input: {
  tenantId: string;
  userId: string;
  roles: string[];
  permissions: string[];
  rowFilters?: AuthorizationContext['row_filters'];
  columnMasks?: AuthorizationContext['column_masks'];
  policyVersion?: number;
}): AuthorizationContext {
  const permissions = sorted(input.permissions);
  const granted = {
    entities: grantedOf(permissions, 'entity'),
    measures: grantedOf(permissions, 'measure'),
    dimensions: grantedOf(permissions, 'dimension'),
  };
  const row_filters = [...(input.rowFilters ?? [])]
    .map((f) => ({ ...f, values: [...f.values].sort() }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const column_masks = [...(input.columnMasks ?? [])].sort((a, b) =>
    canonicalJson(a).localeCompare(canonicalJson(b)),
  );
  const policy_version = input.policyVersion ?? 1;
  const authz_scope_hash = createHash('sha256')
    .update(canonicalJson({ granted, row_filters, column_masks, policy_version }))
    .digest('hex');
  return {
    tenant_id: input.tenantId,
    user_id: input.userId,
    roles: sorted(input.roles),
    permissions,
    granted,
    row_filters,
    column_masks,
    policy_version,
    authz_scope_hash,
  };
}

export function hasPermission(ctx: AuthorizationContext, permission: string): boolean {
  return ctx.permissions.includes(permission);
}
