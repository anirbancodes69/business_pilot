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
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService } from '../platform/database/database.module';

/** Administrator alerts about sync problems (E5.3, E5.5). Codes and ids only, never data. */
@Controller('v1/notifications')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class NotificationsController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('data_source:manage')
  async list(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.notification')
        .select(['id', 'kind', 'severity', 'data_source_id', 'metadata', 'created_at', 'read_at'])
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async read(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException();
    const res = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .updateTable('core.notification')
        .set({ read_at: new Date() })
        .where('id', '=', id)
        .where('read_at', 'is', null)
        .executeTakeFirst(),
    );
    if (Number(res.numUpdatedRows) === 0) throw new NotFoundException();
    return { id, read: true };
  }
}
