import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService } from '../platform/database/database.module';

const body = z.strictObject({ enabled: z.boolean(), acknowledged: z.literal(true) });

/**
 * Whether this workspace's questions and result figures may be sent to the AI model provider
 * (ADR-0022). Only an administrator (`tenant:manage`) can change it, and only by acknowledging what
 * is sent. Every change is audited.
 */
@Controller('v1/tenant/ai-processing')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AiProcessingController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('tenant:read')
  async status(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const t = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.tenant')
        .select(['ai_processing_enabled', 'ai_processing_changed_at'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow(),
    );
    return {
      enabled: t.ai_processing_enabled,
      changed_at: t.ai_processing_changed_at?.toISOString() ?? null,
    };
  }

  @Put()
  @HttpCode(200)
  @RequirePermission('tenant:manage')
  async change(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const parsed = body.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException('send {"enabled": true|false, "acknowledged": true}');
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const now = new Date();
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .updateTable('core.tenant')
        .set({
          ai_processing_enabled: parsed.data.enabled,
          ai_processing_changed_at: now,
          ai_processing_changed_by: userId,
        })
        .where('id', '=', tenantId)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: parsed.data.enabled
          ? 'tenant.ai_processing_enabled'
          : 'tenant.ai_processing_disabled',
        target: tenantId,
        metadata: {},
      });
    });
    return { enabled: parsed.data.enabled, changed_at: now.toISOString() };
  }
}
