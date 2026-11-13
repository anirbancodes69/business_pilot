import { Controller, Get, Inject, NotFoundException, Req, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService } from '../platform/database/database.module';
import { buildAuthorizedView } from './authorized-view';
import { validateSemanticModel } from './semantic-model.validator';

@Controller('v1/semantic-view')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class SemanticViewController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** The caller's own authorized view of the published model. Same builder ai-engine will use (M6). */
  @Get()
  @RequirePermission('tenant:read')
  async view(@Req() req: AuthedRequest) {
    const { tenantId, authz } = req.auth as NonNullable<AuthedRequest['auth']>;
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.semantic_model')
        .select('document')
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .executeTakeFirst(),
    );
    const model = row ? validateSemanticModel(row.document).document : undefined;
    if (!model) throw new NotFoundException('no published semantic model');
    return buildAuthorizedView(model, authz);
  }
}
