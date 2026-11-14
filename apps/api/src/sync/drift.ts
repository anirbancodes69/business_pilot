import { createHash } from 'node:crypto';
import type { DiscoveredObject } from '../connectors/connector';
import type { MappingDocument } from '../mapping/mapping-document';

// Schema drift (E5.3, ADR-0005 item 7). Pure. Only names and types are compared, never values.
// Breaking: the object, a mapped column or a key column is gone, or (catalog sources only) the type
// of a mapped column changed. Additive: new columns appeared that nothing maps yet.

export interface DriftReport {
  breaking: string[];
  additive: number;
  /** Column name to type for every column of the object, stored in the checkpoint. */
  columns: Record<string, string>;
}

export function mappedColumns(mapping: MappingDocument): string[] {
  return [
    ...new Set([
      ...mapping.key_fields,
      ...(mapping.updated_at_field ? [mapping.updated_at_field] : []),
      ...mapping.field_mappings.flatMap((f) => (f.source !== undefined ? [f.source] : [])),
    ]),
  ];
}

export function detectDrift(
  mapping: MappingDocument,
  discovered: DiscoveredObject | undefined,
  previous: Record<string, string> | undefined,
  checkTypes: boolean,
): DriftReport {
  if (!discovered) return { breaking: ['object_missing'], additive: 0, columns: previous ?? {} };
  const columns = Object.fromEntries(discovered.fields.map((f) => [f.name, f.data_type]));
  const breaking: string[] = [];
  for (const name of mappedColumns(mapping)) {
    if (!(name in columns)) breaking.push(`column_missing:${name}`);
    else if (
      checkTypes &&
      previous &&
      previous[name] !== undefined &&
      previous[name] !== columns[name]
    )
      breaking.push(`type_changed:${name}`);
  }
  const additive = previous ? Object.keys(columns).filter((c) => !(c in previous)).length : 0;
  return { breaking, additive, columns };
}

export const mappingHash = (mapping: MappingDocument): string =>
  createHash('sha256').update(JSON.stringify(mapping)).digest('hex');
