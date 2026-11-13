import type { DiscoveredField, DiscoveredObject } from '../connectors/connector';
import { type Attribute, ENTITIES, type Entity, TEMPLATE_ID } from './canonical-catalog';
import type { MappingDocument } from './mapping-document';

// Heuristic mapping suggestions (E4.4). Pure function of column names and types. No cell values are
// read and no model is called: the LLM provider is a dummy (ADR-0015), and ROADMAP E4.4 names
// name similarity as the fallback. Every suggestion is only a draft until a human approves it (D-10).

const ABBREVIATIONS: Record<string, string> = {
  amt: 'amount',
  qty: 'quantity',
  quantities: 'quantity',
  no: 'number',
  num: 'number',
  nbr: 'number',
  dt: 'date',
  inv: 'invoice',
  cust: 'customer',
  prod: 'product',
  desc: 'description',
  addr: 'address',
  disc: 'discount',
  pmt: 'payment',
  ord: 'order',
  stk: 'stock',
  bal: 'balance',
  curr: 'currency',
};
const GENERIC = new Set([
  'master',
  'data',
  'list',
  'sheet',
  'report',
  'table',
  'details',
  'detail',
  'register',
]);
type Transform = NonNullable<MappingDocument['field_mappings'][number]['transforms']>[number];

const MIN_COLUMN_SCORE = 0.5;
const MIN_ENTITY_SCORE = 0.4;

function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lower-case word list: splits camelCase, punctuation and underscores, expands common short forms. */
export function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .map(singular);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const x of sa) if (sb.has(x)) common++;
  return common / (sa.size + sb.size - common);
}

/** Similarity of a column to one attribute, over the attribute name and its synonyms. */
function nameScore(column: string[], attribute: Attribute, entity: Entity): number {
  // "Customer Name" in a customer sheet is just "Name": drop the entity's own words.
  const own = new Set(entity.name.split('_').flatMap(tokens));
  const stripped = column.filter((t) => !own.has(t));
  const candidates = column.length > 0 && stripped.length > 0 ? [column, stripped] : [column];
  const variants = [attribute.name.replace(/_id$/, '_id'), ...(attribute.synonyms ?? [])];
  if (attribute.type === 'ref' && attribute.ref) {
    variants.push(`${attribute.ref} code`, `${attribute.ref} id`, `${attribute.ref} number`);
  }
  let best = 0;
  for (const variant of variants) {
    const vt = tokens(variant);
    for (const c of candidates) best = Math.max(best, jaccard(c, vt));
  }
  return best;
}

/** How well a source type fits an attribute, and the transform that would be needed. */
function typeFit(
  field: DiscoveredField,
  attr: Attribute,
): { factor: number; transforms: Transform[] } {
  const t = field.data_type;
  const numeric =
    t === 'integer' ||
    t === 'numeric' ||
    t.startsWith('numeric') ||
    t === 'bigint' ||
    t === 'double precision';
  const dateLike = t === 'date' || t.startsWith('timestamp');
  switch (attr.type) {
    case 'text':
      return t === 'text' || t.startsWith('character') || t === 'varchar'
        ? { factor: 1, transforms: [{ op: 'trim' }] }
        : { factor: 0.6, transforms: [{ op: 'cast', args: { to: 'text' } }] };
    case 'integer':
      if (t === 'integer' || t === 'bigint' || t === 'smallint')
        return { factor: 1, transforms: [] };
      if (numeric) return { factor: 0.7, transforms: [{ op: 'cast', args: { to: 'integer' } }] };
      return { factor: 0.6, transforms: [{ op: 'parse_number' }] };
    case 'numeric':
      if (numeric) return { factor: 1, transforms: [] };
      return t === 'text' || t.startsWith('character')
        ? { factor: 0.7, transforms: [{ op: 'parse_number' }] }
        : { factor: 0, transforms: [] };
    case 'date':
      if (dateLike) return { factor: 1, transforms: [] };
      return t === 'text' || t.startsWith('character')
        ? { factor: 0.7, transforms: [{ op: 'parse_date' }] }
        : { factor: 0, transforms: [] };
    case 'ref':
      return {
        factor: numeric || t === 'text' || t.startsWith('character') ? 1 : 0.3,
        transforms: [{ op: 'lookup_ref', args: { entity: attr.ref ?? '' } }],
      };
  }
}

interface Assignment {
  attribute: Attribute;
  field: DiscoveredField;
  score: number;
  transforms: Transform[];
}

/** Greedy one-to-one assignment of columns to attributes, best scores first. */
function assign(object: DiscoveredObject, entity: Entity): Assignment[] {
  const columnTokens = new Map(object.fields.map((f) => [f.name, tokens(f.name)]));
  const scored: Assignment[] = [];
  for (const attribute of entity.attributes) {
    for (const field of object.fields) {
      const fit = typeFit(field, attribute);
      const score = nameScore(columnTokens.get(field.name) ?? [], attribute, entity) * fit.factor;
      if (score >= MIN_COLUMN_SCORE)
        scored.push({ attribute, field, score, transforms: fit.transforms });
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.attribute.name.localeCompare(b.attribute.name) ||
      a.field.name.localeCompare(b.field.name),
  );
  const usedAttributes = new Set<string>();
  const usedFields = new Set<string>();
  const chosen: Assignment[] = [];
  for (const s of scored) {
    if (usedAttributes.has(s.attribute.name) || usedFields.has(s.field.name)) continue;
    usedAttributes.add(s.attribute.name);
    usedFields.add(s.field.name);
    chosen.push(s);
  }
  return chosen;
}

function entityScore(object: DiscoveredObject, entity: Entity, assignments: Assignment[]): number {
  const objectTokens = tokens(object.name).filter((t) => !GENERIC.has(t));
  let nameFit = 0;
  for (const variant of [entity.name.replace(/_/g, ' '), ...entity.synonyms]) {
    const vt = tokens(variant);
    nameFit = Math.max(nameFit, jaccard(objectTokens, vt));
    if (vt.length > 0 && vt.every((t) => objectTokens.includes(t)))
      nameFit = Math.max(nameFit, 0.8);
  }
  const required = entity.attributes.filter((a) => a.required);
  const matched = new Set(assignments.map((a) => a.attribute.name));
  const requiredFit = required.length
    ? required.filter((a) => matched.has(a.name)).length / required.length
    : 1;
  const totalFit = matched.size / entity.attributes.length;
  return 0.5 * nameFit + 0.5 * (0.7 * requiredFit + 0.3 * totalFit);
}

export interface Suggestion {
  /** Null when no entity fits well enough. */
  mapping: MappingDocument | null;
  confidence: number;
  /** The entities considered, best first, for the reviewer. */
  alternatives: { entity: string; score: number }[];
}

export function suggestMapping(
  object: DiscoveredObject,
  keyColumns: string[],
  fingerprint: string,
): Suggestion {
  const ranked = ENTITIES.map((entity) => {
    const assignments = assign(object, entity);
    return { entity, assignments, score: entityScore(object, entity, assignments) };
  }).sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name));
  const alternatives = ranked
    .slice(0, 3)
    .map((r) => ({ entity: r.entity.name, score: Math.round(r.score * 100) / 100 }));
  const best = ranked[0];
  if (!best || best.score < MIN_ENTITY_SCORE) return { mapping: null, confidence: 0, alternatives };

  const mapping: MappingDocument = {
    template: TEMPLATE_ID,
    canonical_entity: best.entity.name,
    source_object: object.name,
    source_schema_fingerprint: fingerprint,
    key_fields: keyColumns,
    field_mappings: best.assignments.map((a) => ({
      target: a.attribute.name,
      source: a.field.name,
      ...(a.transforms.length ? { transforms: a.transforms } : {}),
      ...(a.attribute.tags?.length ? { tags: a.attribute.tags } : {}),
      suggested_by_ai: false,
      confidence: Math.round(a.score * 100) / 100,
    })),
    suggestion_method: 'heuristic',
    status: 'suggested',
  };
  return { mapping, confidence: Math.round(best.score * 100) / 100, alternatives };
}
