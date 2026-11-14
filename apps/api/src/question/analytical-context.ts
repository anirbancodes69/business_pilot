import { z } from 'zod';
import type { AuthorizedView } from '../configuration/authorized-view';

// AnalyticalContext of contracts/ai/answer-response.schema.json (v0.2.0, D-21). It holds semantic
// ids, filter values, relative time tokens and evidence references. Never rows, figures or question
// text. It is never a source of authority: the api re-validates it against the user's current
// authorized view before it goes back to ai-engine.

const id = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/);
const evidenceId = z.string().regex(/^ev_[a-z0-9]{4,16}$/);

export const analyticalContextSchema = z.strictObject({
  semantic_model_version: z.number().int().min(1),
  turn: z.number().int().min(1),
  focus: z
    .strictObject({
      metrics: z.array(id).max(5).optional(),
      dimensions: z.array(id).max(3).optional(),
      filters: z
        .array(
          z.strictObject({
            dimension: id,
            operator: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between']),
            values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100),
          }),
        )
        .max(10)
        .optional(),
      time_range: z.record(z.string(), z.unknown()).optional(),
      comparison: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  last_analysis_type: z.string().max(40).optional(),
  open_hypotheses: z
    .array(
      z.strictObject({
        id: z.string().max(40),
        status: z.enum(['open', 'supported', 'not_testable', 'rejected']),
      }),
    )
    .max(10)
    .optional(),
  evidence_refs: z.array(evidenceId).max(50).optional(),
});
export type AnalyticalContext = z.infer<typeof analyticalContextSchema>;

/**
 * Removes whatever the user can no longer see. A context built for another semantic model version
 * is reset (keeping only the turn counter): ids may mean something else now.
 */
export function revalidateContext(
  stored: unknown,
  view: AuthorizedView,
): { context: AnalyticalContext | undefined; reset: boolean } {
  const parsed = analyticalContextSchema.safeParse(stored);
  if (!parsed.success) return { context: undefined, reset: true };
  const ctx = parsed.data;
  if (ctx.semantic_model_version !== view.semantic_model_version)
    return { context: undefined, reset: true };
  const measures = new Set(view.measures.map((m) => m.id));
  const dims = new Set(view.dimensions.map((d) => d.id));
  const focus = ctx.focus && {
    ...ctx.focus,
    metrics: ctx.focus.metrics?.filter((m) => measures.has(m)),
    dimensions: ctx.focus.dimensions?.filter((d) => dims.has(d)),
    filters: ctx.focus.filters?.filter((f) => dims.has(f.dimension)),
  };
  return { context: { ...ctx, focus }, reset: false };
}
