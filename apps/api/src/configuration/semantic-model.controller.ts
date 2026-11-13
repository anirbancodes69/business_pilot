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
import { TEMPLATES } from './templates/wholesale-distribution';
import { validateSemanticModel } from './semantic-model.validator';

function versionParam(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new NotFoundException();
  return n;
}

function validated(body: unknown, version: number): string {
  const { document, problems } = validateSemanticModel(
    typeof body === 'object' && body !== null ? { ...body, version } : body,
  );
  if (!document) throw new BadRequestException({ message: 'invalid semantic model', problems });
  return JSON.stringify(document);
}

/** Drafts are edited by managers; publishing is a separate permission (human approval, D-10). */
@Controller('v1/semantic-models')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class SemanticModelController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('semantic_model:manage')
  list(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.semantic_model')
        .select(['version', 'status', 'created_at', 'published_at'])
        .where('tenant_id', '=', tenantId)
        .orderBy('version', 'desc')
        .execute(),
    );
  }

  @Get(':version')
  @RequirePermission('semantic_model:manage')
  async get(@Req() req: AuthedRequest, @Param('version') v: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const version = versionParam(v);
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.semantic_model')
        .select(['version', 'status', 'document', 'created_at', 'published_at'])
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Creates the next draft. The version number is assigned by the server. */
  @Post()
  @RequirePermission('semantic_model:manage')
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, async (tx) => {
      const last = await tx
        .selectFrom('core.semantic_model')
        .select((eb) => eb.fn.max('version').as('v'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      const version = (last?.v ?? 0) + 1;
      await tx
        .insertInto('core.semantic_model')
        .values({
          tenant_id: tenantId,
          version,
          document: validated(body, version),
          created_by: userId,
        })
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'semantic_model.draft_created',
        target: String(version),
      });
      return { version, status: 'draft' as const };
    });
  }

  /** Creates the next draft from a built-in template. It still needs review and a separate publish. */
  @Post('from-template')
  @RequirePermission('semantic_model:manage')
  createFromTemplate(@Req() req: AuthedRequest, @Body() body: unknown) {
    const parsed = z.strictObject({ template: z.string() }).safeParse(body);
    const make = parsed.success ? TEMPLATES[parsed.data.template] : undefined;
    if (!make) throw new BadRequestException('unknown template');
    return this.create(req, make());
  }

  @Put(':version')
  @RequirePermission('semantic_model:manage')
  replaceDraft(@Req() req: AuthedRequest, @Param('version') v: string, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const version = versionParam(v);
    return this.db.tenantTx(tenantId, async (tx) => {
      const res = await tx
        .updateTable('core.semantic_model')
        .set({ document: validated(body, version) })
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .where('status', '=', 'draft')
        .returning('version')
        .executeTakeFirst();
      if (!res) {
        const exists = await tx
          .selectFrom('core.semantic_model')
          .select('version')
          .where('tenant_id', '=', tenantId)
          .where('version', '=', version)
          .executeTakeFirst();
        if (!exists) throw new NotFoundException();
        throw new ConflictException('only a draft can be changed');
      }
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'semantic_model.draft_updated',
        target: String(version),
      });
      return { version, status: 'draft' as const };
    });
  }

  /** Publishes a draft: it becomes immutable and the previously published version is retired. */
  @Post(':version/publish')
  @RequirePermission('semantic_model:publish')
  publish(@Req() req: AuthedRequest, @Param('version') v: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const version = versionParam(v);
    return this.db.tenantTx(tenantId, async (tx) => {
      const row = await tx
        .selectFrom('core.semantic_model')
        .select(['status', 'document'])
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException();
      if (row.status !== 'draft') throw new ConflictException('only a draft can be published');
      // Re-validate at publish time: the stored draft is not trusted.
      const { problems } = validateSemanticModel(row.document);
      if (problems.length)
        throw new BadRequestException({ message: 'invalid semantic model', problems });
      await tx
        .updateTable('core.semantic_model')
        .set({ status: 'retired' })
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .execute();
      await tx
        .updateTable('core.semantic_model')
        .set({ status: 'published', published_by: userId, published_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'semantic_model.published',
        target: String(version),
      });
      return { version, status: 'published' as const };
    });
  }
}
