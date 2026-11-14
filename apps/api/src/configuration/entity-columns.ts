import { findEntity } from '../mapping/canonical-catalog';
import type { SemanticModelDocument } from './semantic-model.validator';

/**
 * The columns known for each entity of a semantic model: the canonical catalog's attributes for the
 * entity's table, the surrogate key `id`, and every column the model itself names (measures, measure
 * filters, dimensions and relationship keys). Access policy rules are checked against this, so a
 * mask or row filter on a column that does not exist is refused instead of silently doing nothing.
 */
export function entityColumns(model: SemanticModelDocument): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  for (const e of model.entities) {
    const catalog = findEntity(e.table.replace(/^analytics\./, ''));
    columns.set(e.id, new Set(['id', ...(catalog?.attributes.map((a) => a.name) ?? [])]));
  }
  const add = (entity: string, column: string | undefined): void => {
    if (column) columns.get(entity)?.add(column);
  };
  for (const m of model.measures) {
    add(m.entity, m.attribute);
    for (const f of m.filters ?? []) add(m.entity, f.attribute);
  }
  for (const d of model.dimensions) add(d.entity, d.attribute);
  for (const r of model.relationships ?? [])
    for (const [from, to] of r.on) {
      add(r.from, from);
      add(r.to, to);
    }
  return columns;
}
