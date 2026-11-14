import { z } from 'zod';
import type { DiscoveredObject } from '../connectors/connector';
import { findEntity, TEMPLATE_ID, type Tag } from './canonical-catalog';

// The entity mapping document (schemas/configuration/entity-mapping.schema.json, 0.2.0).
// Validation checks the document against the canonical catalog and the discovered source object.
// Status and approval fields are set by the server only: client input for them is ignored.

const TAGS = ['pii', 'sensitive', 'financial'] as const;
const OPS = [
  'trim',
  'lower',
  'upper',
  'cast',
  'parse_date',
  'parse_number',
  'value_map',
  'currency',
  'lookup_ref',
] as const;

const transformSchema = z.strictObject({
  op: z.enum(OPS),
  args: z
    .record(z.string().max(64), z.union([z.string().max(255), z.number(), z.boolean(), z.null()]))
    .refine((r) => Object.keys(r).length <= 50)
    .optional(),
});

const fieldMappingSchema = z
  .strictObject({
    target: z.string().min(1).max(80),
    source: z.string().min(1).max(255).optional(),
    constant: z.union([z.string().max(255), z.number(), z.boolean(), z.null()]).optional(),
    transforms: z.array(transformSchema).max(10).optional(),
    tags: z.array(z.enum(TAGS)).max(3).optional(),
    suggested_by_ai: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((f) => (f.source !== undefined) !== (f.constant !== undefined), {
    message: 'exactly one of source and constant',
  });

export const MAPPING_STATUSES = [
  'suggested',
  'in_review',
  'approved',
  'active',
  'rejected',
  'needs_review',
  'superseded',
] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

const documentSchema = z.strictObject({
  template: z.literal(TEMPLATE_ID),
  canonical_entity: z.string(),
  source_object: z.string().min(1).max(255),
  source_schema_fingerprint: z.string().optional(),
  key_fields: z.array(z.string().min(1).max(255)).min(1).max(5),
  updated_at_field: z.string().min(1).max(255).optional(),
  field_mappings: z.array(fieldMappingSchema).max(100),
  row_filter: z.never().optional(), // the filter grammar is not decided yet: not supported
  /** How the suggestion was made. `heuristic` means name similarity only, no model. */
  suggestion_method: z.enum(['heuristic', 'llm', 'manual']).optional(),
  status: z.enum(MAPPING_STATUSES),
  approved_by: z.string().uuid().optional(),
  approved_at: z.string().optional(),
});
export type MappingDocument = z.infer<typeof documentSchema>;

export interface MappingContext {
  object: DiscoveredObject;
  /** The key columns a human chose and approved for this object. */
  keyColumns: string[];
}

const EXT = /^ext\.[a-z][a-z0-9_]{0,40}$/;

/** Returns the cleaned document or a list of problems (paths and codes only, no values). */
export function validateMappingDocument(
  input: unknown,
  ctx: MappingContext,
  status: MappingStatus,
): { document?: MappingDocument; problems: string[] } {
  const base =
    typeof input === 'object' && input !== null
      ? {
          ...input,
          status,
          approved_by: undefined,
          approved_at: undefined,
        }
      : input;
  const parsed = documentSchema.safeParse(base);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
    };
  const doc = parsed.data;
  const problems: string[] = [];
  const entity = findEntity(doc.canonical_entity);
  if (!entity) return { problems: ['canonical_entity: unknown'] };
  if (doc.source_object !== ctx.object.name) problems.push('source_object: does not match');

  const columns = new Map(ctx.object.fields.map((f) => [f.name, f]));
  const keysMatch =
    doc.key_fields.length === ctx.keyColumns.length &&
    doc.key_fields.every((k) => ctx.keyColumns.includes(k));
  if (!keysMatch) problems.push('key_fields: must equal the approved key columns');
  if (doc.updated_at_field !== undefined) {
    const col = columns.get(doc.updated_at_field);
    if (!col) problems.push('updated_at_field: unknown column');
    else if (!/^(date|timestamp)/.test(col.data_type))
      problems.push('updated_at_field: must be a date or timestamp column');
  }

  const seen = new Set<string>();
  doc.field_mappings.forEach((fm, i) => {
    const at = `field_mappings.${i}`;
    const attr = entity.attributes.find((a) => a.name === fm.target);
    if (!attr && !EXT.test(fm.target)) problems.push(`${at}.target: unknown attribute`);
    if (seen.has(fm.target)) problems.push(`${at}.target: mapped twice`);
    seen.add(fm.target);
    if (fm.source !== undefined && !columns.has(fm.source))
      problems.push(`${at}.source: unknown column`);
    fm.transforms?.forEach((t, j) => {
      if (t.op !== 'lookup_ref') return;
      const target = t.args?.entity;
      if (typeof target !== 'string' || !findEntity(target))
        problems.push(`${at}.transforms.${j}.args.entity: unknown entity`);
      else if (!attr || attr.type !== 'ref' || attr.ref !== target)
        problems.push(`${at}.transforms.${j}: lookup_ref does not fit the target`);
    });
    if (attr?.type === 'ref' && fm.source !== undefined) {
      const lookup = fm.transforms?.some(
        (t) => t.op === 'lookup_ref' && t.args?.entity === attr.ref,
      );
      if (!lookup) problems.push(`${at}.transforms: a reference needs lookup_ref`);
    }
    // Catalog tags can be added to but never removed.
    const forced: Tag[] = attr?.tags ?? [];
    fm.tags = [...new Set([...forced, ...(fm.tags ?? [])])];
    if (fm.tags.length === 0) delete fm.tags;
  });
  if (problems.length > 0) return { problems };
  return { document: doc, problems: [] };
}

/** Required attributes still unmapped. Checked at approval, not while drafting. */
export function missingRequired(doc: MappingDocument): string[] {
  const entity = findEntity(doc.canonical_entity);
  const mapped = new Set(doc.field_mappings.map((f) => f.target));
  return (entity?.attributes ?? [])
    .filter((a) => a.required && !mapped.has(a.name))
    .map((a) => a.name);
}
