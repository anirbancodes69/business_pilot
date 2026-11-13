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

interface ModelRefs {
  entities: { id: string }[];
  measures: { id: string }[];
  dimensions: { id: string }[];
}

/** Structural checks, plus references against the published semantic model and the known roles. */
export function validateAccessPolicy(
  input: unknown,
  refs?: { model: ModelRefs; roleKeys: string[] },
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
    for (const g of p.role_grants) {
      if (!roles.has(g.role)) problems.push(`unknown role: ${g.role}`);
      for (const kind of ['entities', 'measures', 'dimensions'] as const)
        for (const id of g[kind] ?? [])
          if (id !== '*' && !known[kind].has(id)) problems.push(`${g.role}: unknown ${kind} ${id}`);
    }
    for (const r of p.row_rules ?? []) {
      for (const role of r.applies_to_roles)
        if (!roles.has(role)) problems.push(`row rule: unknown role ${role}`);
      if (!known.entities.has(r.entity)) problems.push(`row rule: unknown entity ${r.entity}`);
    }
    for (const c of p.column_rules ?? [])
      if (!known.entities.has(c.entity)) problems.push(`column rule: unknown entity ${c.entity}`);
  }
  return problems.length ? { problems } : { policy: p, problems };
}
