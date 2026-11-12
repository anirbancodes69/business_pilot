import { z } from 'zod';

// Runtime validator for schemas/semantic-model/semantic-model.schema.json (v0.1.0).
// A test compares the property names with the JSON Schema so the two cannot drift silently.
// ADR-0013 (v1 extensions) is not decided; nothing beyond v0 is accepted here.

const id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const dimensionId = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const text = z.string().min(1).max(500);
const synonyms = z.array(text).max(50);

const entity = z.strictObject({
  id,
  label: text,
  description: z.string().max(2000).optional(),
  table: z.string().regex(/^analytics\.[a-z][a-z0-9_]*$/),
  synonyms: synonyms.optional(),
});

const relationship = z.strictObject({
  from: id,
  to: id,
  on: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1),
  cardinality: z.enum(['many_to_one', 'one_to_many', 'one_to_one']),
});

const measure = z.strictObject({
  id,
  label: text,
  description: z.string().max(2000).optional(),
  entity: id,
  aggregation: z.enum(['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'ratio', 'custom']),
  attribute: z.string().min(1).optional(),
  numerator: id.optional(),
  denominator: id.optional(),
  expression_ref: z.string().min(1).optional(),
  filters: z
    .array(
      z.object({
        attribute: z.string().min(1),
        operator: z.enum(['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null']),
        values: z.array(z.unknown()),
      }),
    )
    .optional(),
  unit: z.enum(['currency', 'count', 'percent', 'days', 'quantity']),
  default_time_dimension: z.string().optional(),
  synonyms: synonyms.optional(),
  tags: z.array(z.enum(['pii', 'sensitive', 'financial'])).optional(),
});

const dimension = z.strictObject({
  id: dimensionId,
  label: text,
  entity: id,
  attribute: z.string().min(1),
  type: z.enum(['categorical', 'time', 'numeric', 'boolean']),
  synonyms: synonyms.optional(),
  tags: z.array(z.enum(['pii', 'sensitive'])).optional(),
});

const glossaryTerm = z.strictObject({
  term: text,
  definition: z.string().min(1).max(2000),
  maps_to: z
    .string()
    .regex(/^(measure|dimension|entity):[a-z0-9_.]+$/)
    .optional(),
});

export const semanticModelShape = {
  version: z.number().int().min(1),
  template: z.string().min(1),
  settings: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string().min(1),
    fiscal_year_start_month: z.number().int().min(1).max(12),
    number_format: z.enum(['indian', 'international']).optional(),
  }),
  entities: z.array(entity).min(1).max(200),
  relationships: z.array(relationship).max(500).optional(),
  measures: z.array(measure).max(500),
  dimensions: z.array(dimension).max(500),
  glossary: z.array(glossaryTerm).max(1000).optional(),
};

export const semanticModelSchema = z.strictObject(semanticModelShape);
export type SemanticModelDocument = z.infer<typeof semanticModelSchema>;

function duplicates(ids: string[]): string[] {
  return ids.filter((v, i) => ids.indexOf(v) !== i);
}

/** Structural plus referential checks. Returns human-readable problems (empty = valid). */
export function validateSemanticModel(input: unknown): {
  document?: SemanticModelDocument;
  problems: string[];
} {
  const parsed = semanticModelSchema.safeParse(input);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  const m = parsed.data;
  const problems: string[] = [];
  const entities = new Set(m.entities.map((e) => e.id));
  const measures = new Set(m.measures.map((x) => x.id));
  const dims = new Set(m.dimensions.map((d) => d.id));

  for (const [kind, ids] of [
    ['entity', m.entities.map((e) => e.id)],
    ['measure', m.measures.map((x) => x.id)],
    ['dimension', m.dimensions.map((d) => d.id)],
  ] as const)
    for (const d of duplicates(ids)) problems.push(`duplicate ${kind} id: ${d}`);

  for (const r of m.relationships ?? []) {
    if (!entities.has(r.from)) problems.push(`relationship from unknown entity: ${r.from}`);
    if (!entities.has(r.to)) problems.push(`relationship to unknown entity: ${r.to}`);
  }
  for (const x of m.measures) {
    if (!entities.has(x.entity)) problems.push(`measure ${x.id}: unknown entity ${x.entity}`);
    if (x.aggregation === 'ratio') {
      if (!x.numerator || !x.denominator)
        problems.push(`measure ${x.id}: ratio needs numerator and denominator`);
      for (const ref of [x.numerator, x.denominator])
        if (ref && !measures.has(ref)) problems.push(`measure ${x.id}: unknown measure ${ref}`);
    } else if (x.aggregation === 'custom') {
      if (!x.expression_ref) problems.push(`measure ${x.id}: custom needs expression_ref`);
    } else if (x.aggregation !== 'count' && !x.attribute) {
      problems.push(`measure ${x.id}: ${x.aggregation} needs attribute`);
    }
    if (x.default_time_dimension && !dims.has(x.default_time_dimension))
      problems.push(`measure ${x.id}: unknown time dimension ${x.default_time_dimension}`);
  }
  for (const d of m.dimensions)
    if (!entities.has(d.entity)) problems.push(`dimension ${d.id}: unknown entity ${d.entity}`);
  for (const g of m.glossary ?? []) {
    if (!g.maps_to) continue;
    const [kind, ref] = g.maps_to.split(':') as [string, string];
    const set = kind === 'measure' ? measures : kind === 'dimension' ? dims : entities;
    if (!set.has(ref)) problems.push(`glossary "${g.term}": unknown target ${g.maps_to}`);
  }
  return problems.length ? { problems } : { document: m, problems };
}
