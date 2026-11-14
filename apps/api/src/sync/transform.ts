import { createHash } from 'node:crypto';
import type { SourceRow, SourceValue } from '../connectors/connector';
import { findEntity } from '../mapping/canonical-catalog';
import type { MappingDocument } from '../mapping/mapping-document';

// Turns one source row into one canonical row (docs/data/sync-engine.md, "Run algorithm").
// Pure and deterministic: the same row and mapping always give the same row and content hash.
// Errors carry a field name and a code, never a value (SECURITY.md: no row data in logs).

export type { SourceRow, SourceValue };
export type CanonicalValue = string | number | boolean | null;

/** A `lookup_ref` resolves the source key of a referenced entity to its canonical id, or null. */
export type RefResolver = (entity: string, sourceKey: string) => string | null;

export class RowError extends Error {
  constructor(
    readonly field: string,
    readonly code: string,
  ) {
    super(`${field}: ${code}`);
  }
}

export interface TransformedRow {
  sourceKey: string;
  columns: Record<string, CanonicalValue>;
  ext: Record<string, CanonicalValue>;
  contentHash: string;
  /** Referenced rows that were not found: the row is kept with a null reference and counted. */
  unresolvedRefs: string[];
}

/** One stable string per key tuple. Dates are normalized so the same cell gives the same key. */
export function sourceKeyOf(row: SourceRow, keyFields: string[]): string {
  const parts = keyFields.map((f) => {
    const v = row[f];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === ''))
      throw new RowError(f, 'key_missing');
    return v instanceof Date ? v.toISOString() : String(v).trim();
  });
  return JSON.stringify(parts);
}

function toDate(value: SourceValue, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RowError(field, 'bad_date');
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let parts: [string, string, string] | undefined;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (ymd) parts = [ymd[1] as string, ymd[2] as string, ymd[3] as string];
  else {
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // Indian day-first order
    if (dmy)
      parts = [
        dmy[3] as string,
        (dmy[2] as string).padStart(2, '0'),
        (dmy[1] as string).padStart(2, '0'),
      ];
  }
  if (!parts) throw new RowError(field, 'bad_date');
  const iso = parts.join('-');
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso)
    throw new RowError(field, 'bad_date');
  return iso;
}

function toNumber(value: SourceValue, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RowError(field, 'bad_number');
    return value;
  }
  if (typeof value !== 'string') throw new RowError(field, 'bad_number');
  const cleaned = value.replace(/[₹$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new RowError(field, 'bad_number');
  return Number(cleaned);
}

function applyOp(
  value: SourceValue | CanonicalValue,
  op: string,
  args: Record<string, string | number | boolean | null> | undefined,
  field: string,
  refs: RefResolver,
  unresolved: string[],
): SourceValue | CanonicalValue {
  switch (op) {
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'parse_date':
      return toDate(value as SourceValue, field);
    case 'parse_number':
      return toNumber(value as SourceValue, field);
    case 'cast': {
      const to = args?.to;
      if (to === 'text') return value === null || value === undefined ? null : String(value);
      if (to === 'integer') {
        const n = toNumber(value as SourceValue, field);
        if (n !== null && !Number.isInteger(n)) throw new RowError(field, 'bad_integer');
        return n;
      }
      if (to === 'numeric') return toNumber(value as SourceValue, field);
      if (to === 'date') return toDate(value as SourceValue, field);
      throw new RowError(field, 'bad_cast');
    }
    case 'value_map': {
      if (value === null || value === undefined) return null;
      const key = String(value).trim();
      const map = args ?? {};
      if (Object.hasOwn(map, key)) return map[key] ?? null;
      const lower = Object.keys(map).find((k) => k.toLowerCase() === key.toLowerCase());
      return lower !== undefined ? (map[lower] ?? null) : value;
    }
    case 'currency': {
      const s = value === null || value === undefined ? '' : String(value).trim().toUpperCase();
      if (s === '') return typeof args?.default === 'string' ? args.default : 'INR';
      if (!/^[A-Z]{3}$/.test(s)) throw new RowError(field, 'bad_currency');
      return s;
    }
    case 'lookup_ref': {
      if (value === null || value === undefined || value === '') return null;
      const entity = String(args?.entity ?? '');
      const id = refs(entity, JSON.stringify([String(value).trim()]));
      if (id === null) unresolved.push(field);
      return id;
    }
    default:
      throw new RowError(field, 'unknown_op');
  }
}

/** Coerces a value to the column type when the mapping did not already. */
function finalize(
  value: SourceValue | CanonicalValue,
  type: string,
  field: string,
): CanonicalValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'date':
      return toDate(value as SourceValue, field);
    case 'integer': {
      const n = toNumber(value as SourceValue, field);
      if (n !== null && !Number.isInteger(n)) throw new RowError(field, 'bad_integer');
      return n;
    }
    case 'numeric':
      return toNumber(value as SourceValue, field);
    case 'ref':
      return String(value);
    default:
      return value instanceof Date ? value.toISOString() : (value as CanonicalValue);
  }
}

export function transformRow(
  row: SourceRow,
  mapping: MappingDocument,
  refs: RefResolver,
): TransformedRow {
  const entity = findEntity(mapping.canonical_entity);
  if (!entity) throw new RowError('canonical_entity', 'unknown');
  const sourceKey = sourceKeyOf(row, mapping.key_fields);
  const columns: Record<string, CanonicalValue> = {};
  const ext: Record<string, CanonicalValue> = {};
  const unresolved: string[] = [];

  for (const fm of mapping.field_mappings) {
    let value: SourceValue | CanonicalValue =
      fm.source !== undefined ? row[fm.source] : fm.constant;
    for (const t of fm.transforms ?? [])
      value = applyOp(value, t.op, t.args, fm.target, refs, unresolved);
    if (fm.target.startsWith('ext.')) {
      ext[fm.target.slice(4)] = finalize(value, 'text', fm.target);
      continue;
    }
    const attr = entity.attributes.find((a) => a.name === fm.target);
    if (!attr) throw new RowError(fm.target, 'unknown_attribute');
    // A reference column stores the canonical id: only lookup_ref produces one.
    columns[fm.target] = finalize(value, attr.type, fm.target);
  }

  // Hash over the mapped values and the version of the mapping inputs, in a fixed key order.
  const sorted = (o: Record<string, CanonicalValue>): [string, CanonicalValue][] =>
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));
  const contentHash = createHash('sha256')
    .update(JSON.stringify([sorted(columns), sorted(ext)]))
    .digest('hex');
  return { sourceKey, columns, ext, contentHash, unresolvedRefs: unresolved };
}
