import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { DataSourceService } from '../connectors/data-source.service';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService, type Tx } from '../platform/database/database.module';
import {
  type MappingDocument,
  type MappingStatus,
  missingRequired,
  validateMappingDocument,
} from './mapping-document';
import { suggestMapping } from './suggester';

const suggestBody = z.strictObject({
  objects: z.array(z.string().min(1).max(255)).max(100).optional(),
});
const EDITABLE: MappingStatus[] = ['suggested', 'in_review', 'needs_review'];

function uuid(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new NotFoundException();
  return value;
}

/**
 * Mapping workflow (D-10): suggested, in_review, approved, active. Suggesting, editing and rejecting
 * need data_source:manage. Approving and activating need mapping:approve, a separate permission.
 * Nothing here reads source rows: suggestions use column names and types only.
 */
@Controller('v1/data-sources/:sourceId/mappings')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class MappingController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DataSourceService) private readonly sources: DataSourceService,
  ) {}

  @Get()
  @RequirePermission('data_source:manage')
  list(@Req() req: AuthedRequest, @Param('sourceId') sourceId: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.entity_mapping')
        .select([
          'id',
          'source_object',
          'canonical_entity',
          'status',
          'confidence',
          'updated_at',
          'approved_at',
          'activated_at',
        ])
        .where('data_source_id', '=', uuid(sourceId))
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  @Get(':id')
  @RequirePermission('data_source:manage')
  async get(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
  ) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.entity_mapping')
        .select(['id', 'status', 'confidence', 'document'])
        .where('data_source_id', '=', uuid(sourceId))
        .where('id', '=', uuid(id))
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Suggests a mapping for each approved object (or the named ones). An earlier suggestion that is
   * still unreviewed is superseded. Approved and active mappings are left alone.
   */
  @Post('suggest')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async suggest(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const parsed = suggestBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid request');
    const dataSourceId = uuid(sourceId);

    const approved = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_object')
        .select(['name', 'key_columns'])
        .where('data_source_id', '=', dataSourceId)
        .where('approved', '=', true)
        .execute(),
    );
    const wanted = parsed.data.objects;
    const targets = wanted ? approved.filter((o) => wanted.includes(o.name)) : approved;
    if (wanted && targets.length !== new Set(wanted).size)
      throw new ConflictException('every object must be approved before it can be mapped');
    if (targets.length === 0) throw new ConflictException('approve at least one object first');

    const { schema } = await this.sources.discover(tenantId, dataSourceId);
    const results: {
      object: string;
      mapping_id?: string;
      entity?: string;
      confidence: number;
      alternatives: { entity: string; score: number }[];
    }[] = [];

    await this.db.tenantTx(tenantId, async (tx) => {
      for (const target of targets) {
        const object = schema.objects.find((o) => o.name === target.name);
        if (!object) continue; // the object disappeared from the source since it was approved
        const suggestion = suggestMapping(object, target.key_columns, schema.fingerprint);
        if (!suggestion.mapping) {
          results.push({
            object: target.name,
            confidence: 0,
            alternatives: suggestion.alternatives,
          });
          continue;
        }
        await tx
          .updateTable('core.entity_mapping')
          .set({ status: 'superseded', updated_at: new Date() })
          .where('data_source_id', '=', dataSourceId)
          .where('source_object', '=', target.name)
          .where('status', 'in', ['suggested', 'in_review', 'needs_review'])
          .execute();
        const row = await tx
          .insertInto('core.entity_mapping')
          .values({
            tenant_id: tenantId,
            data_source_id: dataSourceId,
            source_object: target.name,
            canonical_entity: suggestion.mapping.canonical_entity,
            document: JSON.stringify(suggestion.mapping),
            confidence: suggestion.confidence,
            created_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(tx, {
          tenantId,
          actorId: userId,
          action: 'mapping.suggested',
          target: row.id,
          metadata: {
            data_source_id: dataSourceId,
            entity: suggestion.mapping.canonical_entity,
            method: 'heuristic',
            fields: suggestion.mapping.field_mappings.length,
          },
        });
        results.push({
          object: target.name,
          mapping_id: row.id,
          entity: suggestion.mapping.canonical_entity,
          confidence: suggestion.confidence,
          alternatives: suggestion.alternatives,
        });
      }
    });
    return results;
  }

  /** Edits a draft. The reviewer may change targets, sources, transforms and the entity. */
  @Put(':id')
  @RequirePermission('data_source:manage')
  async edit(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuid(sourceId);
    const current = await this.load(tenantId, dataSourceId, uuid(id));
    if (!EDITABLE.includes(current.status))
      throw new ConflictException('this mapping can no longer be edited');
    const ctx = await this.contextFor(tenantId, dataSourceId, current.source_object);
    const { document, problems } = validateMappingDocument(body, ctx, 'in_review');
    if (!document) throw new BadRequestException({ message: 'invalid mapping', problems });
    document.source_schema_fingerprint = ctx.fingerprint;
    document.suggestion_method =
      document.suggestion_method === 'heuristic' && this.sameAs(current.document, document)
        ? 'heuristic'
        : 'manual';
    return this.db.tenantTx(tenantId, async (tx) => {
      await this.save(tx, current.id, document, 'in_review');
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'mapping.edited',
        target: current.id,
        metadata: { entity: document.canonical_entity, fields: document.field_mappings.length },
      });
      return { id: current.id, status: 'in_review' as const };
    });
  }

  /** Marks a suggestion as read by a human, without changing it. */
  @Post(':id/review')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async review(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const current = await this.load(tenantId, uuid(sourceId), uuid(id));
    if (current.status !== 'suggested' && current.status !== 'needs_review')
      throw new ConflictException('only a suggestion can be moved to review');
    return this.db.tenantTx(tenantId, async (tx) => {
      await this.save(tx, current.id, { ...current.document, status: 'in_review' }, 'in_review');
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'mapping.reviewed',
        target: current.id,
      });
      return { id: current.id, status: 'in_review' as const };
    });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async reject(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const current = await this.load(tenantId, uuid(sourceId), uuid(id));
    if (!EDITABLE.includes(current.status))
      throw new ConflictException('this mapping can no longer be rejected');
    return this.db.tenantTx(tenantId, async (tx) => {
      await this.save(tx, current.id, { ...current.document, status: 'rejected' }, 'rejected');
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'mapping.rejected',
        target: current.id,
      });
      return { id: current.id, status: 'rejected' as const };
    });
  }

  /**
   * Human approval (D-10). Needs a mapping that was reviewed, every required attribute mapped,
   * the object still approved, and the document still valid against the source as it is now.
   */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('mapping:approve')
  async approve(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuid(sourceId);
    const current = await this.load(tenantId, dataSourceId, uuid(id));
    if (current.status !== 'in_review')
      throw new ConflictException('review the mapping before approving it');
    const ctx = await this.contextFor(tenantId, dataSourceId, current.source_object);
    const { document, problems } = validateMappingDocument(current.document, ctx, 'approved');
    if (!document)
      throw new UnprocessableEntityException({
        message: 'the mapping no longer fits the source',
        problems,
      });
    const missing = missingRequired(document);
    if (missing.length > 0)
      throw new UnprocessableEntityException({
        message: 'required attributes are not mapped',
        problems: missing.map((m) => `${m}: required`),
      });
    document.source_schema_fingerprint = ctx.fingerprint;
    const now = new Date();
    document.approved_by = userId;
    document.approved_at = now.toISOString();
    return this.db.tenantTx(tenantId, async (tx) => {
      const result = await tx
        .updateTable('core.entity_mapping')
        .set({
          status: 'approved',
          document: JSON.stringify(document),
          approved_by: userId,
          approved_at: now,
          updated_at: now,
        })
        .where('id', '=', current.id)
        .where('status', '=', 'in_review')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new ConflictException('the mapping was changed by someone else');
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'mapping.approved',
        target: current.id,
        metadata: { entity: document.canonical_entity },
      });
      return { id: current.id, status: 'approved' as const };
    });
  }

  /** Makes an approved mapping the one that feeds sync. The previous active one is superseded. */
  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('mapping:approve')
  async activate(
    @Req() req: AuthedRequest,
    @Param('sourceId') sourceId: string,
    @Param('id') id: string,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuid(sourceId);
    const current = await this.load(tenantId, dataSourceId, uuid(id));
    if (current.status !== 'approved') throw new ConflictException('approve the mapping first');
    const stillApproved = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_object')
        .select('id')
        .where('data_source_id', '=', dataSourceId)
        .where('name', '=', current.source_object)
        .where('approved', '=', true)
        .executeTakeFirst(),
    );
    if (!stillApproved) throw new ConflictException('the object is no longer approved');
    const now = new Date();
    return this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .updateTable('core.entity_mapping')
        .set({ status: 'superseded', updated_at: now })
        .where('data_source_id', '=', dataSourceId)
        .where('source_object', '=', current.source_object)
        .where('status', '=', 'active')
        .execute();
      const result = await tx
        .updateTable('core.entity_mapping')
        .set({
          status: 'active',
          document: JSON.stringify({ ...current.document, status: 'active' }),
          activated_by: userId,
          activated_at: now,
          updated_at: now,
        })
        .where('id', '=', current.id)
        .where('status', '=', 'approved')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new ConflictException('the mapping was changed by someone else');
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'mapping.activated',
        target: current.id,
        metadata: { entity: current.canonical_entity, object: current.source_object },
      });
      return { id: current.id, status: 'active' as const };
    });
  }

  private async load(tenantId: string, dataSourceId: string, id: string) {
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.entity_mapping')
        .select(['id', 'status', 'source_object', 'canonical_entity', 'document'])
        .where('data_source_id', '=', dataSourceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return { ...row, document: row.document as MappingDocument };
  }

  /** The current source object and its approved key columns, from a fresh discovery. */
  private async contextFor(tenantId: string, dataSourceId: string, objectName: string) {
    const approved = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_object')
        .select(['key_columns', 'approved'])
        .where('data_source_id', '=', dataSourceId)
        .where('name', '=', objectName)
        .executeTakeFirst(),
    );
    if (!approved?.approved) throw new ConflictException('the object is not approved');
    const { schema } = await this.sources.discover(tenantId, dataSourceId);
    const object = schema.objects.find((o) => o.name === objectName);
    if (!object) throw new ConflictException('the object no longer exists in the source');
    return { object, keyColumns: approved.key_columns, fingerprint: schema.fingerprint };
  }

  /** Moves an unfinished mapping to a new draft state. Fails if another request changed it first. */
  private async save(tx: Tx, id: string, document: MappingDocument, status: MappingStatus) {
    const result = await tx
      .updateTable('core.entity_mapping')
      .set({
        status,
        document: JSON.stringify({ ...document, status }),
        canonical_entity: document.canonical_entity,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('status', 'in', EDITABLE)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new ConflictException('the mapping was changed by someone else');
  }

  /** True when an edit left the suggested field mappings exactly as they were. */
  private sameAs(before: MappingDocument, after: MappingDocument): boolean {
    return (
      before.canonical_entity === after.canonical_entity &&
      JSON.stringify(before.field_mappings) === JSON.stringify(after.field_mappings)
    );
  }
}
