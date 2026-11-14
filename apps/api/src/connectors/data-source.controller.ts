import { createHash, randomUUID } from 'node:crypto';
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
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { ENVELOPE_TOKEN } from '../platform/crypto/crypto.module';
import type { EnvelopeCrypto } from '../platform/crypto/envelope';
import { DatabaseService, type Tx } from '../platform/database/database.module';
import {
  OBJECT_STORAGE_TOKEN,
  type ObjectStorage,
} from '../platform/object-storage/object-storage';
import { ConnectorConfigError, SchemaError, type DiscoveredSchema } from './connector';
import { assertSafeXlsx, MAX_UPLOAD_BYTES } from './excel/zip-guard';
import { ConnectorRegistry } from './connector-registry';
import { CREDENTIAL_PURPOSE, DataSourceService } from './data-source.service';

const keysBody = z.strictObject({ key_columns: z.array(z.string().min(1).max(255)).min(1).max(5) });

/** A display name only. The stored object key never contains it. */
function safeFileName(raw: unknown): string {
  const base = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9 ._()-]/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned === '' ? 'upload.xlsx' : cleaned;
}

function objectName(value: string): string {
  if (value.length < 1 || value.length > 255) throw new NotFoundException();
  return value;
}

const createBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  access_mode: z.enum(['managed_sync', 'live_federated']).default('managed_sync'),
  connection: z.record(z.string(), z.unknown()),
  credentials: z.unknown().optional(),
});

function uuidParam(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new NotFoundException();
  return value;
}

/** What the API returns for a data source. Never the credential or its reference. */
function present(row: {
  id: string;
  name: string;
  type: string;
  access_mode: string;
  connection: unknown;
  credential_id: string | null;
  status: string;
  last_tested_at: Date | null;
  created_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    access_mode: row.access_mode,
    connection: row.connection,
    has_credentials: row.credential_id !== null,
    status: row.status,
    last_tested_at: row.last_tested_at,
    created_at: row.created_at,
  };
}

/** Data sources (E4.1). Every route needs data_source:manage. Credentials are write-only. */
@Controller('v1')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class DataSourceController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(ENVELOPE_TOKEN) private readonly crypto: EnvelopeCrypto | null,
    @Inject(OBJECT_STORAGE_TOKEN) private readonly storage: ObjectStorage,
    @Inject(DataSourceService) private readonly sources: DataSourceService,
  ) {}

  @Get('connectors')
  @RequirePermission('data_source:manage')
  connectors() {
    return this.registry.list();
  }

  @Get('data-sources')
  @RequirePermission('data_source:manage')
  list(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, async (tx) =>
      (await tx.selectFrom('core.data_source').selectAll().orderBy('created_at').execute()).map(
        present,
      ),
    );
  }

  @Get('data-sources/:id')
  @RequirePermission('data_source:manage')
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source')
        .selectAll()
        .where('id', '=', uuidParam(id))
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return present(row);
  }

  @Post('data-sources')
  @RequirePermission('data_source:manage')
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const parsed = createBody.safeParse(body);
    // Issue paths only. Zod messages can echo submitted values, and the body can hold a password.
    if (!parsed.success)
      throw new BadRequestException({
        message: 'invalid data source',
        problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
      });
    const input = parsed.data;
    const connector = this.registry.get(input.type);
    if (!connector) throw new BadRequestException('unknown connector type');
    if (!connector.describeCapabilities().access_modes.includes(input.access_mode))
      throw new BadRequestException('access mode is not supported by this connector');

    let connection: unknown;
    let credentials: unknown;
    try {
      connection = connector.parseConfig(input.connection);
      credentials = connector.parseCredentials(input.credentials);
    } catch (error) {
      if (error instanceof ConnectorConfigError)
        throw new BadRequestException({ message: error.message, problems: error.problems });
      throw error;
    }

    return this.db.tenantTx(tenantId, async (tx) => {
      const credentialId = await this.storeCredentials(tx, tenantId, credentials);
      const taken = await tx
        .selectFrom('core.data_source')
        .select('id')
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (taken) throw new ConflictException('a data source with this name already exists');
      const row = await tx
        .insertInto('core.data_source')
        .values({
          tenant_id: tenantId,
          name: input.name,
          type: input.type,
          access_mode: input.access_mode,
          connection: JSON.stringify(connection),
          credential_id: credentialId,
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.created',
        target: row.id,
        metadata: { type: input.type, access_mode: input.access_mode },
      });
      return present(row);
    });
  }

  /** Runs the connector's connection test. Reports fixed messages, never driver text. */
  @Post('data-sources/:id/test')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async test(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const { connector, ctx, dataSourceId } = await this.sources.prepare(tenantId, uuidParam(id));
    let result;
    try {
      result = await connector.testConnection(ctx);
    } catch (error) {
      if (error instanceof ConnectorConfigError)
        throw new UnprocessableEntityException('the stored configuration is invalid');
      throw error;
    }
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .updateTable('core.data_source')
        .set({ status: result.ok ? 'connected' : 'error', last_tested_at: new Date() })
        .where('id', '=', dataSourceId)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.tested',
        target: dataSourceId,
        metadata: { ok: result.ok, warnings: result.privilege_warnings.length },
      });
    });
    return result;
  }

  /**
   * Discovers tables or sheets with columns, types and keys. Metadata only, no row values.
   * Runs in the api for now because the worker has no job queue until Milestone 5.
   */
  @Post('data-sources/:id/discover-schema')
  @HttpCode(200)
  @RequirePermission('data_source:manage')
  async discover(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const { schema, dataSourceId } = await this.sources.discover(tenantId, uuidParam(id));
    await this.db.tenantTx(tenantId, (tx) =>
      this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.schema_discovered',
        target: dataSourceId,
        metadata: { objects: schema.objects.length, fingerprint: schema.fingerprint },
      }),
    );
    return schema;
  }

  /**
   * Receives an .xlsx file as the raw request body (E4.2). The file is checked before it is stored:
   * size, archive structure and expansion limits. Each upload is a new version.
   */
  @Post('data-sources/:id/upload')
  @RequirePermission('data_source:manage')
  async upload(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuidParam(id);
    const source = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source')
        .select(['id', 'connection'])
        .where('id', '=', dataSourceId)
        .executeTakeFirst(),
    );
    if (!source) throw new NotFoundException();
    if ((source.connection as { upload_mode?: string }).upload_mode !== 'manual')
      throw new ConflictException('this data source does not accept uploads');

    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim();
    if (
      type !== 'application/octet-stream' &&
      type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
      throw new UnsupportedMediaTypeException();
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException();
      chunks.push(chunk as Buffer);
    }
    const file = Buffer.concat(chunks);
    if (file.length === 0) throw new BadRequestException('the file is empty');
    try {
      assertSafeXlsx(file);
    } catch (error) {
      if (error instanceof SchemaError) throw new UnprocessableEntityException(error.message);
      throw error;
    }

    const uploadId = randomUUID();
    const key = `uploads/${dataSourceId}/${uploadId}.xlsx`;
    const sha256 = createHash('sha256').update(file).digest('hex');
    await this.storage.put(tenantId, key, file);
    return this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .insertInto('core.data_source_upload')
        .values({
          id: uploadId,
          tenant_id: tenantId,
          data_source_id: dataSourceId,
          object_key: key,
          file_name: safeFileName(req.headers['x-file-name']),
          size_bytes: file.length,
          sha256,
          created_by: userId,
        })
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.file_uploaded',
        target: dataSourceId,
        metadata: { upload_id: uploadId, size_bytes: file.length, sha256 },
      });
      return { upload_id: uploadId, size_bytes: file.length, sha256 };
    });
  }

  @Get('data-sources/:id/objects')
  @RequirePermission('data_source:manage')
  async objects(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_object')
        .select(['name', 'key_columns', 'approved', 'approved_at'])
        .where('data_source_id', '=', uuidParam(id))
        .orderBy('name')
        .execute(),
    );
  }

  /**
   * Chooses the key columns of one table or sheet. Checked against a fresh discovery. A changed key
   * withdraws any earlier approval. Approval itself is a separate permission (D-10).
   */
  @Put('data-sources/:id/objects/:name')
  @RequirePermission('data_source:manage')
  async setKeys(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const parsed = keysBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid key selection');
    const columns = [...new Set(parsed.data.key_columns)];
    const { schema, dataSourceId } = await this.sources.discover(tenantId, uuidParam(id));
    this.assertKeys(schema, objectName(name), columns);
    return this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .insertInto('core.data_source_object')
        .values({
          tenant_id: tenantId,
          data_source_id: dataSourceId,
          name,
          key_columns: JSON.stringify(columns),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'data_source_id', 'name']).doUpdateSet({
            key_columns: JSON.stringify(columns),
            approved: false,
            approved_by: null,
            approved_at: null,
            updated_at: new Date(),
          }),
        )
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.keys_selected',
        target: dataSourceId,
        metadata: { object: name, key_columns: columns },
      });
      return { name, key_columns: columns, approved: false };
    });
  }

  /** Human approval: nothing is read from an object until this has happened (D-10). */
  @Post('data-sources/:id/objects/:name/approve')
  @HttpCode(200)
  @RequirePermission('mapping:approve')
  async approve(@Req() req: AuthedRequest, @Param('id') id: string, @Param('name') name: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const dataSourceId = uuidParam(id);
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_object')
        .select('key_columns')
        .where('data_source_id', '=', dataSourceId)
        .where('name', '=', objectName(name))
        .executeTakeFirst(),
    );
    if (!row || row.key_columns.length === 0)
      throw new ConflictException('choose key columns first');
    // The source may have changed since the keys were chosen.
    const { schema } = await this.sources.discover(tenantId, dataSourceId);
    this.assertKeys(schema, name, row.key_columns);
    return this.db.tenantTx(tenantId, async (tx) => {
      // Approve only the key that was just checked: the selection may have changed meanwhile.
      const now = await tx
        .selectFrom('core.data_source_object')
        .select('key_columns')
        .where('data_source_id', '=', dataSourceId)
        .where('name', '=', name)
        .forUpdate()
        .executeTakeFirst();
      if (!now || JSON.stringify(now.key_columns) !== JSON.stringify(row.key_columns))
        throw new ConflictException('the key selection was changed by someone else');
      await tx
        .updateTable('core.data_source_object')
        .set({ approved: true, approved_by: userId, approved_at: new Date() })
        .where('data_source_id', '=', dataSourceId)
        .where('name', '=', name)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'data_source.object_approved',
        target: dataSourceId,
        metadata: { object: name },
      });
      return { name, approved: true };
    });
  }

  /** Key columns must exist. For files they must also be present and unique in every row. */
  private assertKeys(schema: DiscoveredSchema, name: string, columns: string[]): void {
    const object = schema.objects.find((o) => o.name === name);
    if (!object) throw new NotFoundException();
    const names = new Set(object.fields.map((f) => f.name));
    if (columns.some((c) => !names.has(c)))
      throw new BadRequestException('a key column does not exist');
    if (object.key_candidates) {
      const [only] = columns;
      if (columns.length !== 1 || !only || !object.key_candidates.includes(only))
        throw new UnprocessableEntityException(
          'the key must be one column whose values are present and unique in every row',
        );
    }
  }

  private async storeCredentials(
    tx: Tx,
    tenantId: string,
    credentials: unknown,
  ): Promise<string | null> {
    if (credentials === undefined) return null;
    if (!this.crypto) throw new ServiceUnavailableException('key management is not configured');
    const tenant = await tx
      .selectFrom('core.tenant')
      .select(['key_id', 'wrapped_data_key'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    if (!tenant.key_id || !tenant.wrapped_data_key)
      throw new ServiceUnavailableException('tenant key is not available');
    const sealed = this.crypto.encrypt(
      tenantId,
      { keyId: tenant.key_id, wrappedDataKey: tenant.wrapped_data_key },
      Buffer.from(JSON.stringify(credentials), 'utf8'),
      CREDENTIAL_PURPOSE,
    );
    const row = await tx
      .insertInto('core.connector_credential')
      .values({ tenant_id: tenantId, key_id: sealed.keyId, ciphertext: sealed.ciphertext })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
