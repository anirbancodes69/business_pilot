import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { validateAccessPolicy } from '../authorization/access-policy.validator';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService, type Tx } from '../platform/database/database.module';
import { entityColumns } from './entity-columns';
import { validateSemanticModel } from './semantic-model.validator';
import { TEMPLATES_POLICY } from './templates/wholesale-distribution';

function versionParam(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new NotFoundException();
  return n;
}

/** Drafts and activation of the tenant access policy. Both need tenant:manage (human approval). */
@Controller('v1/access-policies')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AccessPolicyController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * References are checked against the published model, the roles visible to this tenant, the
   * permission catalog and the columns known for each entity.
   */
  private async refs(tx: Tx, tenantId: string) {
    const modelRow = await tx
      .selectFrom('core.semantic_model')
      .select('document')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'published')
      .executeTakeFirst();
    const model = modelRow ? validateSemanticModel(modelRow.document).document : undefined;
    if (!model) throw new ConflictException('publish a semantic model first');
    const roles = await tx.selectFrom('core.role').select('key').execute();
    const permissions = await tx.selectFrom('core.permission').select('key').execute();
    return {
      model,
      roleKeys: roles.map((r) => r.key),
      permissionKeys: permissions.map((p) => p.key),
      entityColumns: entityColumns(model),
    };
  }

  private async createDraft(tx: Tx, tenantId: string, userId: string, body: unknown) {
    const last = await tx
      .selectFrom('core.access_policy')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    const version = (last?.v ?? 0) + 1;
    const input =
      typeof body === 'object' && body !== null ? { ...body, policy_version: version } : body;
    const { policy, problems } = validateAccessPolicy(input, await this.refs(tx, tenantId));
    if (!policy) throw new BadRequestException({ message: 'invalid access policy', problems });
    await tx
      .insertInto('core.access_policy')
      .values({ tenant_id: tenantId, version, document: JSON.stringify(policy) })
      .execute();
    await this.audit.record(tx, {
      tenantId,
      actorId: userId,
      action: 'access_policy.draft_created',
      target: String(version),
    });
    return { version, status: 'draft' as const };
  }

  @Get()
  @RequirePermission('tenant:manage')
  list(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.access_policy')
        .select(['version', 'status', 'created_at'])
        .where('tenant_id', '=', tenantId)
        .orderBy('version', 'desc')
        .execute(),
    );
  }

  @Get(':version')
  @RequirePermission('tenant:manage')
  async get(@Req() req: AuthedRequest, @Param('version') v: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const version = versionParam(v);
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.access_policy')
        .select(['version', 'status', 'document'])
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @RequirePermission('tenant:manage')
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) => this.createDraft(tx, tenantId, userId, body));
  }

  @Post('from-template')
  @RequirePermission('tenant:manage')
  createFromTemplate(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const parsed = z.strictObject({ template: z.string() }).safeParse(body);
    const make = parsed.success ? TEMPLATES_POLICY[parsed.data.template] : undefined;
    if (!make) throw new BadRequestException('unknown template');
    return this.db.tenantTx(tenantId, (tx) => this.createDraft(tx, tenantId, userId, make()));
  }

  /** Activating retires the previous active policy. Takes effect on each user's next request. */
  @Post(':version/activate')
  @RequirePermission('tenant:manage')
  activate(@Req() req: AuthedRequest, @Param('version') v: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const version = versionParam(v);
    return this.db.tenantTx(tenantId, async (tx) => {
      const row = await tx
        .selectFrom('core.access_policy')
        .select(['status', 'document'])
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException();
      if (row.status !== 'draft') throw new ConflictException('only a draft can be activated');
      const { problems } = validateAccessPolicy(row.document, await this.refs(tx, tenantId));
      if (problems.length)
        throw new BadRequestException({ message: 'invalid access policy', problems });
      await tx
        .updateTable('core.access_policy')
        .set({ status: 'retired' })
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .execute();
      await tx
        .updateTable('core.access_policy')
        .set({ status: 'active' })
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'access_policy.activated',
        target: String(version),
      });
      return { version, status: 'active' as const };
    });
  }
}
