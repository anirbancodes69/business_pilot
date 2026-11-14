import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService } from '../platform/database/database.module';
import { SyncQueue } from './sync-queue';

function uuidParam(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new NotFoundException();
  return value;
}

/** Sync requests, run history and per-dataset freshness (E5.1, E5.5 in part). */
@Controller('v1')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class SyncController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SyncQueue) private readonly queue: SyncQueue,
  ) {}

  /** Queues a sync. The job carries identifiers only. */
  @Post('data-sources/:id/sync')
  @HttpCode(202)
  @RequirePermission('data_source:manage')
  async request(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuidParam(id);
    await this.db.tenantTx(tenantId, async (tx) => {
      const source = await tx
        .selectFrom('core.data_source')
        .select('id')
        .where('id', '=', dataSourceId)
        .executeTakeFirst();
      if (!source) throw new NotFoundException();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'sync.requested',
        target: dataSourceId,
      });
    });
    return this.queue.enqueue({ tenantId, dataSourceId, trigger: 'manual' });
  }

  @Get('data-sources/:id/sync-runs')
  @RequirePermission('data_source:manage')
  async runs(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.sync_run')
        .select(['id', 'status', 'trigger', 'started_at', 'finished_at', 'stats', 'error_code'])
        .where('data_source_id', '=', uuidParam(id))
        .orderBy('started_at', 'desc')
        .limit(20)
        .execute(),
    );
  }

  /** Freshness per dataset: data_version, status and the last successful sync time. */
  @Get('data-sources/:id/datasets')
  @RequirePermission('data_source:manage')
  async datasets(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.dataset')
        .select([
          'canonical_entity',
          'data_version',
          'status',
          'last_attempt_at',
          'last_successful_sync_at',
          'row_count',
        ])
        .where('data_source_id', '=', uuidParam(id))
        .orderBy('canonical_entity')
        .execute(),
    );
  }
}
