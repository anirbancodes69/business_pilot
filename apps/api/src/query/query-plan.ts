import { z } from 'zod';

// Runtime validator for contracts/ai/query-plan.schema.json (v0.1.0). A test compares the property
// names with the JSON Schema. A plan is untrusted input: it comes from model output.

const semanticId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/);
const absolute = z.strictObject({
  start: z.iso.date(),
  end: z.iso.date(),
  time_dimension: semanticId.optional(),
});
const relative = z.strictObject({
  relative: z.enum([
    'today',
    'yesterday',
    'this_week',
    'last_week',
    'this_month',
    'last_month',
    'this_quarter',
    'last_quarter',
    'this_year',
    'last_year',
    'fiscal_ytd',
    'this_fiscal_year',
    'last_fiscal_year',
    'last_n_days',
    'last_n_months',
  ]),
  n: z.number().int().min(1).max(730).optional(),
  time_dimension: semanticId.optional(),
});
const timeRange = z.union([absolute, relative]);

export const queryPlanShape = {
  plan_version: z.literal('0.1'),
  semantic_model_version: z.number().int().min(1),
  intent: z.enum(['metric', 'ranking', 'comparison', 'trend', 'diagnostic', 'recommendation']),
  measures: z.array(semanticId).min(1).max(5),
  dimensions: z
    .array(
      z.strictObject({
        id: semanticId,
        time_grain: z
          .enum(['day', 'week', 'month', 'quarter', 'fiscal_quarter', 'year', 'fiscal_year'])
          .optional(),
      }),
    )
    .max(3)
    .optional(),
  filters: z
    .array(
      z.strictObject({
        dimension: semanticId,
        operator: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between']),
        values: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .min(1)
          .max(100),
      }),
    )
    .max(10)
    .optional(),
  time_range: timeRange,
  comparison: z
    .strictObject({
      type: z.enum(['previous_period', 'same_period_last_year', 'custom']),
      time_range: timeRange,
    })
    .optional(),
  breakdowns: z.array(semanticId).max(5).optional(),
  sort: z
    .array(z.strictObject({ by: semanticId, direction: z.enum(['asc', 'desc']) }))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  rationale: z.string().max(500).optional(),
};

export const queryPlanSchema = z.strictObject(queryPlanShape);
export type QueryPlan = z.infer<typeof queryPlanSchema>;
export type TimeRange = z.infer<typeof timeRange>;
