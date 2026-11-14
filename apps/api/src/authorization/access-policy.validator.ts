import { z } from 'zod';

// Runtime validator for schemas/tenant/access-policy.schema.json (v0.1.0).
const ids = z.array(z.string().min(1)).max(1000);

export const accessPolicySchema = z.strictObject({
  policy_version: z.number().int().min(1),
  role_grants: z
    .array(
      z.strictObject({
        role: z.string().min(1),
        entities: ids.optional(),
        measures: ids.optional(),
        dimensions: ids.optional(),
        permissions: ids.optional(),
      }),
    )
    .max(100),
  row_rules: z
    .array(
      z.strictObject({
        applies_to_roles: z.array(z.string().min(1)).min(1),
        entity: z.string().min(1),
        attribute: z.string().min(1),
        operator: z.enum(['eq', 'in']),
        user_attribute: z.string().min(1),
      }),
    )
    .max(100)
    .optional(),
  column_rules: z
    .array(
      z.strictObject({
        entity: z.string().min(1),
        attribute: z.string().min(1),
        mask: z.enum(['hide', 'redact', 'hash']),
        except_roles: z.array(z.string().min(1)).optional(),
      }),
    )
    .max(500)
    .optional(),
});
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

/**
 * Permissions an access policy may never hand out. They control who administers the tenant and who
 * gives the human approval required by D-10, so they come only from a role assignment, which is
 * audited separately (membership.roles_changed).
 */
export const RESTRICTED_POLICY_PERMISSIONS: readonly string[] = [
  'tenant:manage',
  'user:manage',
  'data_source:manage',
  'mapping:approve',
  'semantic_model:manage',
  'semantic_model:publish',
];

const DATA_GRANT = /^(entity|measure|dimension):/;

/** Data grants go through `entities`, `measures` and `dimensions`, which are checked against the model. */
export function isPolicyGrantable(permission: string): boolean {
  return !RESTRICTED_POLICY_PERMISSIONS.includes(permission) && !DATA_GRANT.test(permission);
}

interface ModelRefs {
  entities: { id: string }[];
  measures: { id: string }[];
  dimensions: { id: string }[];
}

export interface PolicyRefs {
  model: ModelRefs;
  roleKeys: string[];
  /** The permission catalog (core.permission). */
  permissionKeys: string[];
  /** Columns known for each entity of the published model (see configuration/entity-columns.ts). */
  entityColumns: Map<string, Set<string>>;
}

/**
 * Structural checks, plus references against the published semantic model, the known roles, the
 * permission catalog and the entity columns. A rule that names an unknown column is rejected: a
 * mask or row filter on a misspelt column would otherwise protect nothing while looking valid.
 */
export function validateAccessPolicy(
  input: unknown,
  refs?: PolicyRefs,
): { policy?: AccessPolicy; problems: string[] } {
  const parsed = accessPolicySchema.safeParse(input);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  const p = parsed.data;
  const problems: string[] = [];
  if (refs) {
    const known = {
      entities: new Set(refs.model.entities.map((e) => e.id)),
      measures: new Set(refs.model.measures.map((m) => m.id)),
      dimensions: new Set(refs.model.dimensions.map((d) => d.id)),
    };
    const roles = new Set(refs.roleKeys);
    const permissions = new Set(refs.permissionKeys);
    for (const g of p.role_grants) {
      if (!roles.has(g.role)) problems.push(`unknown role: ${g.role}`);
      for (const kind of ['entities', 'measures', 'dimensions'] as const)
        for (const id of g[kind] ?? [])
          if (id !== '*' && !known[kind].has(id)) problems.push(`${g.role}: unknown ${kind} ${id}`);
      for (const perm of g.permissions ?? []) {
        if (DATA_GRANT.test(perm))
          problems.push(`${g.role}: grant data through entities, measures or dimensions`);
        else if (RESTRICTED_POLICY_PERMISSIONS.includes(perm))
          problems.push(`${g.role}: permission ${perm} cannot be granted by a policy`);
        else if (!permissions.has(perm)) problems.push(`${g.role}: unknown permission ${perm}`);
      }
    }
    const columnProblem = (what: string, entity: string, attribute: string): void => {
      if (!known.entities.has(entity)) problems.push(`${what}: unknown entity ${entity}`);
      else if (!refs.entityColumns.get(entity)?.has(attribute))
        problems.push(`${what}: unknown attribute ${entity}.${attribute}`);
    };
    for (const r of p.row_rules ?? []) {
      for (const role of r.applies_to_roles)
        if (!roles.has(role)) problems.push(`row rule: unknown role ${role}`);
      columnProblem('row rule', r.entity, r.attribute);
    }
    for (const c of p.column_rules ?? []) columnProblem('column rule', c.entity, c.attribute);
  }
  return problems.length ? { problems } : { policy: p, problems };
}
