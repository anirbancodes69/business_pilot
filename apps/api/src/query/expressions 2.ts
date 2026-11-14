import type { SemanticModelDocument } from '../configuration/semantic-model.validator';

// Vetted SQL expressions for measures with aggregation `custom` (the semantic model names them by
// `expression_ref`; it never contains SQL). Each lists the columns it reads, so a column mask on
// any of them hides the measure. `b` is the alias of the measure's own table.

export interface ExpressionContext {
  /** Values of the tenant's business rules, already numbers (settings.business_rules). */
  rule: (id: string) => number | undefined;
  /** Binds a parameter and returns its placeholder. */
  param: (value: unknown, cast?: string) => string;
  /** Placeholder for today's date (a bound `date` parameter). */
  asOf: () => string;
  /** Days in the query's time range, inclusive. Throws if the range is not absolute. */
  periodDays: () => number;
}

export interface CustomExpression {
  entity: string;
  columns: string[];
  build: (cx: ExpressionContext) => string;
}

// Allocated payments per invoice (not soft-deleted). The tenant predicate is explicit as well as RLS.
const allocated = `COALESCE((SELECT SUM(a.amount) FROM analytics.payment_allocation a
  WHERE a.tenant_id = b.tenant_id AND a.invoice_id = b.id AND a.deleted_at IS NULL), 0)`;

export const CUSTOM_EXPRESSIONS: Record<string, CustomExpression> = {
  // Days sales outstanding: what is still owed, as days of sales over the period. Needs the period's
  // length, so it is only defined for an absolute time range.
  days_sales_outstanding: {
    entity: 'invoice',
    columns: ['net_amount', 'id'],
    build: (cx) =>
      `SUM(b.net_amount - ${allocated}) / NULLIF(SUM(b.net_amount), 0) * ${cx.param(cx.periodDays(), 'integer')}`,
  },
  gross_margin: {
    entity: 'invoice_line',
    columns: ['net_amount', 'cost_amount'],
    build: () => `SUM(b.net_amount - b.cost_amount) FILTER (WHERE b.cost_amount IS NOT NULL)`,
  },
  outstanding_receivables: {
    entity: 'invoice',
    columns: ['net_amount', 'id'],
    build: () => `SUM(b.net_amount - ${allocated})`,
  },
  overdue_receivables: {
    entity: 'invoice',
    columns: ['net_amount', 'due_date', 'id'],
    build: (cx) => {
      const days = cx.rule('overdue_days');
      if (days === undefined || !Number.isInteger(days) || days < 0)
        throw new Error('overdue_days rule missing');
      return `SUM(b.net_amount - ${allocated}) FILTER (WHERE b.due_date < ${cx.asOf()} - ${cx.param(days, 'integer')})`;
    },
  },
};

/** Columns of the measure's own entity that it reads (for column masks). Ratios read their parts'. */
export function measureColumns(
  model: SemanticModelDocument,
  measureId: string,
  seen = new Set<string>(),
): { entity: string; column: string }[] {
  const m = model.measures.find((x) => x.id === measureId);
  if (!m || seen.has(measureId)) return [];
  seen.add(measureId);
  const own = (c: string) => ({ entity: m.entity, column: c });
  const cols = [
    ...(m.attribute ? [own(m.attribute)] : []),
    ...(m.filters ?? []).map((f) => own(f.attribute)),
    ...(m.expression_ref ? (CUSTOM_EXPRESSIONS[m.expression_ref]?.columns ?? []).map(own) : []),
  ];
  for (const part of [m.numerator, m.denominator])
    if (part) cols.push(...measureColumns(model, part, seen));
  return cols;
}
