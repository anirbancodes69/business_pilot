import type { AuthorizationContext } from './authorization';
import { type AccessPolicy, isPolicyGrantable } from './access-policy.validator';

interface ModelIds {
  entities: { id: string }[];
  measures: { id: string }[];
  dimensions: { id: string }[];
}

export interface PolicyEffect {
  permissions: string[];
  rowFilters: AuthorizationContext['row_filters'];
  columnMasks: AuthorizationContext['column_masks'];
}

const scalar = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number';

/**
 * Pure and default-deny. Grants are the union over the user's roles ('*' = everything in the
 * published model). Row rules resolve user attributes into values now, so the hash covers them.
 * A row rule whose attribute is missing or empty yields an empty `in` list: it matches no rows
 * (fail closed). The plan compiler must treat an empty list as false.
 */
export function evaluatePolicy(input: {
  policy: AccessPolicy;
  model: ModelIds;
  roles: string[];
  userId: string;
  attributes: Record<string, unknown>;
}): PolicyEffect {
  const { policy, model, roles, userId, attributes } = input;
  const mine = new Set(roles);
  const permissions = new Set<string>();
  const expand = (kind: 'entity' | 'measure' | 'dimension', wanted: string[] | undefined) => {
    const all = model[`${kind === 'entity' ? 'entities' : `${kind}s`}` as keyof ModelIds].map(
      (x) => x.id,
    );
    const set = new Set(all);
    for (const id of wanted ?? [])
      if (id === '*') all.forEach((a) => permissions.add(`${kind}:${a}:read`));
      else if (set.has(id)) permissions.add(`${kind}:${id}:read`);
  };
  for (const g of policy.role_grants) {
    if (!mine.has(g.role)) continue;
    expand('entity', g.entities);
    expand('measure', g.measures);
    expand('dimension', g.dimensions);
    // A stored policy is not trusted: restricted permissions and hand-written data grants are
    // dropped here too, so a policy saved before this rule existed cannot grant them.
    for (const p of g.permissions ?? []) if (isPolicyGrantable(p)) permissions.add(p);
  }

  const rowFilters: AuthorizationContext['row_filters'] = [];
  for (const r of policy.row_rules ?? []) {
    if (!r.applies_to_roles.some((role) => mine.has(role))) continue;
    const raw = r.user_attribute === 'user_id' ? userId : attributes[r.user_attribute];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(scalar);
    rowFilters.push({
      entity: r.entity,
      attribute: r.attribute,
      operator: r.operator === 'eq' && values.length === 1 ? 'eq' : 'in',
      values,
    });
  }

  const columnMasks: AuthorizationContext['column_masks'] = [];
  for (const c of policy.column_rules ?? [])
    if (!(c.except_roles ?? []).some((role) => mine.has(role)))
      columnMasks.push({ entity: c.entity, attribute: c.attribute, mask: c.mask });

  return { permissions: [...permissions], rowFilters, columnMasks };
}
