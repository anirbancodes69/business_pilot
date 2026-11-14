import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService, sql } from '../platform/database/database.module';

const days = z.coerce.number().int().min(1).max(365).default(30);

/** Model usage of the workspace (E6.8). Counts only. Cost needs a price list per model: not stored. */
@Controller('v1/usage')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class UsageController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('tenant:manage')
  async summary(@Req() req: AuthedRequest, @Query('days') daysRaw?: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const window = days.parse(daysRaw ?? undefined);
    const since = new Date(Date.now() - window * 86_400_000);
    return this.db.tenantTx(tenantId, async (tx) => {
      const total = await tx
        .selectFrom('core.ai_execution')
        .select([
          sql<string>`count(*)`.as('questions'),
          sql<string>`coalesce(sum(planner_calls + explainer_calls), 0)`.as('model_calls'),
          sql<string>`coalesce(sum(input_tokens), 0)`.as('input_tokens'),
          sql<string>`coalesce(sum(output_tokens), 0)`.as('output_tokens'),
          sql<string>`coalesce(round(avg(duration_ms)), 0)`.as('avg_duration_ms'),
        ])
        .where('tenant_id', '=', tenantId)
        .where('created_at', '>=', since)
        .executeTakeFirstOrThrow();
      const byStatus = await tx
        .selectFrom('core.ai_execution')
        .select(['status', sql<string>`count(*)`.as('questions')])
        .where('tenant_id', '=', tenantId)
        .where('created_at', '>=', since)
        .groupBy('status')
        .orderBy('status')
        .execute();
      return {
        since: since.toISOString(),
        days: window,
        questions: Number(total.questions),
        model_calls: Number(total.model_calls),
        input_tokens: Number(total.input_tokens),
        output_tokens: Number(total.output_tokens),
        avg_duration_ms: Number(total.avg_duration_ms),
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.questions)])),
      };
    });
  }
}
