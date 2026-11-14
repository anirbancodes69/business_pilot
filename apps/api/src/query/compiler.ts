import type { AuthorizationContext } from '../authorization/authorization';
import { buildAuthorizedView } from '../configuration/authorized-view';
import { entityColumns } from '../configuration/entity-columns';
import type { SemanticModelDocument } from '../configuration/semantic-model.validator';
import { assertUuid } from '../platform/database/tenant-tx';
import { CUSTOM_EXPRESSIONS } from './expressions';
import type { QueryPlan, TimeRange } from './query-plan';

/**
 * Plan compiler (docs/ai/orchestration-pipeline.md). Pure: a validated plan, the published semantic
 * model and the user's AuthorizationContext in; parameterized SQL out. Nothing from the plan is ever
 * placed in SQL text except identifiers that come from the semantic model and were checked against
 * the known columns; every plan value is a bound parameter.
 *
 * - `forbidden` (403): the plan names something the user may not use, or a row filter cannot be applied.
 * - `invalid` (422): the plan cannot be compiled (unknown id, relative dates, unsupported shape).
 * Both messages are fixed text that never echoes plan values.
 */
export class PlanRejected extends Error {
  constructor(
    readonly kind: 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export interface CompiledColumn {
  name: string;
  semantic_id: string;
  kind: 'dimension' | 'measure';
  type: string;
  unit?: string;
}

export interface CompiledQuery {
  role: 'current' | 'comparison';
  sql: string;
  params: unknown[];
  columns: CompiledColumn[];
  /** The limit the caller asked for. The SQL fetches limit + 1 rows to detect truncation. */
  limit: number;
}

export const DEFAULT_MAX_LIMIT = 100;

const IDENT = /^[a-z][a-z0-9_]*$/;
const q = (name: string): string => {
  if (!IDENT.test(name)) throw new PlanRejected('invalid', 'unsafe identifier in the model');
  return `"${name}"`;
};
const reject = (kind: 'forbidden' | 'invalid', m: string): never => {
  throw new PlanRejected(kind, m);
};
const NOT_AVAILABLE = 'a measure, dimension or filter is not available';

export function compilePlan(input: {
  plan: QueryPlan;
  model: SemanticModelDocument;
  ctx: AuthorizationContext;
  /** Today in the tenant's time zone, YYYY-MM-DD. Used only by "overdue" style measures. */
  asOf: string;
  maxLimit?: number;
}): CompiledQuery[] {
  const { plan, model, ctx } = input;
  if (plan.semantic_model_version !== model.version)
    reject('invalid', 'plan was made for another semantic model version');
  if (plan.breakdowns?.length) reject('invalid', 'breakdowns must be expanded into separate plans');
  assertUuid(ctx.tenant_id, 'tenant id');

  const periods: { role: 'current' | 'comparison'; range: TimeRange }[] = [
    { role: 'current', range: plan.time_range },
  ];
  if (plan.comparison) periods.push({ role: 'comparison', range: plan.comparison.time_range });
  return periods.map((p) => compileOne(input, p.role, p.range));
}

function compileOne(
  input: Parameters<typeof compilePlan>[0],
  role: 'current' | 'comparison',
  range: TimeRange,
): CompiledQuery {
  const { plan, model, ctx } = input;
  const maxLimit = input.maxLimit ?? DEFAULT_MAX_LIMIT;
  const view = buildAuthorizedView(model, ctx);
  const viewMeasures = new Map(view.measures.map((m) => [m.id, m]));
  const viewDims = new Set(view.dimensions.map((d) => d.id));
  const viewEntities = new Set(view.entities.map((e) => e.id));
  const dimById = new Map(model.dimensions.map((d) => [d.id, d]));
  const entityById = new Map(model.entities.map((e) => [e.id, e]));
  const measureById = new Map(model.measures.map((m) => [m.id, m]));
  const known = entityColumns(model);

  const params: unknown[] = [];
  const param = (value: unknown, cast?: string): string => {
    params.push(value);
    return cast ? `$${params.length}::${cast}` : `$${params.length}`;
  };

  // 1. Everything the plan names must be in the user's authorized view.
  const dimIds = (plan.dimensions ?? []).map((d) => d.id);
  const filterIds = (plan.filters ?? []).map((f) => f.dimension);
  for (const id of plan.measures) if (!viewMeasures.has(id)) reject('forbidden', NOT_AVAILABLE);
  for (const id of [...dimIds, ...filterIds])
    if (!viewDims.has(id)) reject('forbidden', NOT_AVAILABLE);

  // 2. One base entity: all measures of a plan live on the same table (no fan-out, no cross-joins).
  const baseIds = new Set(
    plan.measures.map((id) => (measureById.get(id) as { entity: string }).entity),
  );
  if (baseIds.size !== 1) reject('invalid', 'measures of one plan must belong to one entity');
  const base = [...baseIds][0] as string;
  if (!viewEntities.has(base)) reject('forbidden', NOT_AVAILABLE);

  // 3. Joins: only declared many_to_one relationships, followed from the base entity.
  const parent = new Map<string, { from: string; on: [string, string][] }>();
  const queue = [base];
  const seen = new Set([base]);
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const r of model.relationships ?? [])
      if (r.from === cur && r.cardinality === 'many_to_one' && !seen.has(r.to)) {
        seen.add(r.to);
        parent.set(r.to, { from: cur, on: r.on });
        queue.push(r.to);
      }
  }
  const rowFilterEntities = new Set(ctx.row_filters.map((f) => f.entity));
  const aliasOf = (entity: string): string => (entity === base ? 'b' : `j_${entity}`);
  const col = (entity: string, column: string): string => {
    if (!known.get(entity)?.has(column)) reject('invalid', 'unknown column in the model');
    return `${aliasOf(entity)}.${q(column)}`;
  };

  // The time dimension the range applies to.
  const timeDimId =
    range.time_dimension ?? measureById.get(plan.measures[0] as string)?.default_time_dimension;
  if (!timeDimId || !viewDims.has(timeDimId)) reject('invalid', 'no usable time dimension');
  const timeDim = dimById.get(timeDimId as string);
  if (timeDim?.type !== 'time') reject('invalid', 'the time dimension is not a time dimension');

  const needed = new Set<string>();
  for (const id of [...dimIds, ...filterIds, timeDimId as string])
    needed.add((dimById.get(id) as { entity: string }).entity);
  for (const e of rowFilterEntities) {
    // A row rule on an entity this query cannot reach would be silently skipped: refuse instead.
    if (e !== base && !seen.has(e))
      reject('forbidden', 'a row restriction cannot be applied to this query');
    needed.add(e);
  }
  for (const e of needed)
    if (e !== base && !seen.has(e)) reject('invalid', 'no declared join path');
  const joined: string[] = [];
  const addPath = (e: string): void => {
    if (e === base || joined.includes(e)) return;
    addPath((parent.get(e) as { from: string }).from);
    joined.push(e);
  };
  for (const e of [...needed].sort()) addPath(e);

  const from = (e: string): string => {
    const t = (entityById.get(e) as { table: string }).table.split('.');
    return `${q(t[0] as string)}.${q(t[1] as string)}`;
  };
  const joins = joined.map((e) => {
    const p = parent.get(e) as { from: string; on: [string, string][] };
    const a = aliasOf(e);
    const prev = aliasOf(p.from);
    const on = p.on.map(([fromCol, toCol]) => {
      if (!known.get(p.from)?.has(fromCol) || !known.get(e)?.has(toCol))
        reject('invalid', 'unknown column in the model');
      return `${a}.${q(toCol)} = ${prev}.${q(fromCol)}`;
    });
    const kind = rowFilterEntities.has(e) ? 'INNER' : 'LEFT';
    return `${kind} JOIN ${from(e)} ${a} ON ${a}.tenant_id = ${prev}.tenant_id AND ${a}.deleted_at IS NULL AND ${on.join(' AND ')}`;
  });

  // 4. Select list.
  const fiscal = model.settings.fiscal_year_start_month - 1;
  const shift = `make_interval(months => ${Number(fiscal)})`;
  const dimExpr = (id: string, grain?: string): string => {
    const d = dimById.get(id) as { entity: string; attribute: string; type: string };
    const c = col(d.entity, d.attribute);
    if (!grain) return c;
    if (d.type !== 'time') return reject('invalid', 'a time grain needs a time dimension');
    const t = `${c}::timestamp`;
    const unit: Record<string, string> = {
      day: `date_trunc('day', ${t})::date`,
      week: `date_trunc('week', ${t})::date`,
      month: `date_trunc('month', ${t})::date`,
      quarter: `date_trunc('quarter', ${t})::date`,
      year: `date_trunc('year', ${t})::date`,
      fiscal_quarter: `(date_trunc('quarter', ${t} - ${shift}) + ${shift})::date`,
      fiscal_year: `(date_trunc('year', ${t} - ${shift}) + ${shift})::date`,
    };
    return unit[grain] as string;
  };
  const columns: CompiledColumn[] = [];
  const select: string[] = [];
  (plan.dimensions ?? []).forEach((d, i) => {
    const meta = dimById.get(d.id) as { type: string };
    select.push(`${dimExpr(d.id, d.time_grain)} AS d${i}`);
    columns.push({
      name: `d${i}`,
      semantic_id: d.id,
      kind: 'dimension',
      type: d.time_grain ? 'date' : meta.type,
    });
  });

  const rules = new Map((model.settings.business_rules ?? []).map((r) => [r.id, r.value]));
  const condition = (c: string, op: string, values: unknown[]): string => {
    const v = values as (string | number)[];
    switch (op) {
      case 'eq':
        return `${c} = ${param(v[0])}`;
      case 'neq':
        return `${c} IS DISTINCT FROM ${param(v[0])}`;
      case 'in':
        return `${c} = ANY(${param(v)})`;
      case 'not_in':
        return `(${c} IS NULL OR ${c} <> ALL(${param(v)}))`;
      case 'is_null':
        return `${c} IS NULL`;
      case 'is_not_null':
        return `${c} IS NOT NULL`;
      default:
        return reject('invalid', 'unsupported operator');
    }
  };
  const measureExpr = (id: string, depth = 0): string => {
    const m = measureById.get(id);
    if (!m || depth > 3) return reject('invalid', 'cannot compile the measure');
    if (m.entity !== base) return reject('invalid', 'a ratio must use parts from its own entity');
    if (m.aggregation === 'ratio')
      return `(${measureExpr(m.numerator as string, depth + 1)})::numeric / NULLIF(${measureExpr(m.denominator as string, depth + 1)}, 0)`;
    if (m.aggregation === 'custom') {
      const ex = CUSTOM_EXPRESSIONS[m.expression_ref ?? ''];
      if (!ex || ex.entity !== m.entity) return reject('invalid', 'measure is not supported yet');
      return ex.build({
        rule: (rid) => rules.get(rid),
        param,
        asOf: () => param(input.asOf, 'date'),
      });
    }
    const attr = m.attribute ? col(m.entity, m.attribute) : '';
    const agg: Record<string, string> = {
      sum: `SUM(${attr})`,
      avg: `AVG(${attr})`,
      min: `MIN(${attr})`,
      max: `MAX(${attr})`,
      count: 'COUNT(*)',
      count_distinct: `COUNT(DISTINCT ${attr})`,
    };
    const filter = (m.filters ?? []).map((f) =>
      condition(col(m.entity, f.attribute), f.operator, f.values),
    );
    return `${agg[m.aggregation] as string}${filter.length ? ` FILTER (WHERE ${filter.join(' AND ')})` : ''}`;
  };
  plan.measures.forEach((id, i) => {
    select.push(`${measureExpr(id)} AS m${i}`);
    columns.push({
      name: `m${i}`,
      semantic_id: id,
      kind: 'measure',
      type: 'numeric',
      unit: viewMeasures.get(id)?.unit,
    });
  });

  // 5. Predicates: tenant, soft delete, time range, row restrictions, plan filters.
  const where: string[] = [`b.tenant_id = ${param(ctx.tenant_id, 'uuid')}`, 'b.deleted_at IS NULL'];
  if (!('start' in range)) return reject('invalid', 'the time range must be absolute');
  if (range.start > range.end) reject('invalid', 'the time range ends before it starts');
  const tcol = col(
    (timeDim as { entity: string }).entity,
    (timeDim as { attribute: string }).attribute,
  );
  where.push(`${tcol} >= ${param(range.start, 'date')}`, `${tcol} <= ${param(range.end, 'date')}`);

  for (const f of ctx.row_filters) {
    where.push(
      f.values.length === 0
        ? 'FALSE'
        : `${col(f.entity, f.attribute)}::text = ANY(${param(f.values.map(String), 'text[]')})`,
    );
  }
  for (const f of plan.filters ?? []) {
    const d = dimById.get(f.dimension) as { entity: string; attribute: string; type: string };
    const c = col(d.entity, d.attribute);
    const cast = { time: 'date', numeric: 'numeric', boolean: 'boolean', categorical: 'text' }[
      d.type
    ] as string;
    const ok = (v: unknown): boolean =>
      d.type === 'numeric'
        ? typeof v === 'number'
        : d.type === 'boolean'
          ? typeof v === 'boolean'
          : d.type === 'time'
            ? typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
            : typeof v === 'string' || typeof v === 'number';
    if (!f.values.every(ok)) reject('invalid', 'filter values do not match the dimension type');
    const vals = d.type === 'categorical' ? f.values.map(String) : f.values;
    const left = d.type === 'categorical' ? `${c}::text` : c;
    const cmp = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>;
    if (f.operator in cmp) {
      if (d.type === 'categorical' || d.type === 'boolean' || vals.length !== 1)
        reject('invalid', 'comparison filters need one numeric or date value');
      where.push(`${left} ${cmp[f.operator]} ${param(vals[0], cast)}`);
    } else if (f.operator === 'between') {
      if (d.type === 'categorical' || d.type === 'boolean' || vals.length !== 2)
        reject('invalid', 'between needs two numeric or date values');
      where.push(`${left} BETWEEN ${param(vals[0], cast)} AND ${param(vals[1], cast)}`);
    } else if (f.operator === 'in' || f.operator === 'not_in') {
      const arr = param(vals, `${cast}[]`);
      where.push(
        f.operator === 'in'
          ? `${left} = ANY(${arr})`
          : `(${left} IS NULL OR ${left} <> ALL(${arr}))`,
      );
    } else {
      if (vals.length !== 1) reject('invalid', 'this filter needs exactly one value');
      where.push(
        f.operator === 'eq'
          ? `${left} = ${param(vals[0], cast)}`
          : `${left} IS DISTINCT FROM ${param(vals[0], cast)}`,
      );
    }
  }

  // 6. Grouping, ordering and the limit. The order is always fully determined.
  const position = new Map<string, number>();
  columns.forEach((c, i) => position.set(c.semantic_id, i + 1));
  const sorts = (plan.sort ?? []).map((s) => {
    const p = position.get(s.by);
    if (!p) return reject('invalid', 'sort must refer to a measure or dimension of the plan');
    return `${p} ${s.direction.toUpperCase()} NULLS LAST`;
  });
  const dimPositions = dimIds.map((_, i) => i + 1);
  if (!sorts.length) {
    const timeFirst = (plan.dimensions ?? []).findIndex((d) => d.time_grain);
    if (timeFirst >= 0) sorts.push(`${timeFirst + 1} ASC`);
    else if (dimIds.length) sorts.push(`${dimIds.length + 1} DESC NULLS LAST`);
  }
  for (const p of dimPositions)
    if (!sorts.some((s) => s.startsWith(`${p} `))) sorts.push(`${p} ASC`);
  const limit = Math.min(plan.limit ?? maxLimit, maxLimit);

  const sql = [
    `SELECT ${select.join(', ')}`,
    `FROM ${from(base)} b`,
    ...joins,
    `WHERE ${where.join(' AND ')}`,
    dimPositions.length ? `GROUP BY ${dimPositions.join(', ')}` : '',
    sorts.length ? `ORDER BY ${sorts.join(', ')}` : '',
    `LIMIT ${limit + 1}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { role, sql, params, columns, limit };
}
