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
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
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
  type Connector,
  type ConnectorCallContext,
  ConnectorConfigError,
  ConnectorError,
} from './connector';
import { ConnectorRegistry } from './connector-registry';

const CALL_BUDGET_MS = 30_000;
const CREDENTIAL_PURPOSE = 'connector_credential';

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
    const { connector, ctx, dataSourceId } = await this.prepare(tenantId, uuidParam(id));
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
    const { connector, ctx, dataSourceId } = await this.prepare(tenantId, uuidParam(id));
    let schema;
    try {
      schema = await connector.discoverSchema(ctx);
    } catch (error) {
      if (error instanceof ConnectorConfigError)
        throw new UnprocessableEntityException('the stored configuration is invalid');
      if (error instanceof ConnectorError)
        throw new ServiceUnavailableException(`schema discovery failed: ${error.message}`);
      throw error;
    }
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

  /** Loads the data source and decrypts its credentials in memory for one call. */
  private async prepare(
    tenantId: string,
    id: string,
  ): Promise<{
    connector: Connector;
    dataSourceId: string;
    ctx: ConnectorCallContext;
  }> {
    const loaded = await this.db.tenantTx(tenantId, async (tx) => {
      const source = await tx
        .selectFrom('core.data_source')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!source) return null;
      let credentials: unknown;
      if (source.credential_id) {
        if (!this.crypto) throw new ServiceUnavailableException('key management is not configured');
        const row = await tx
          .selectFrom('core.connector_credential')
          .select(['key_id', 'ciphertext'])
          .where('id', '=', source.credential_id)
          .executeTakeFirstOrThrow();
        const tenant = await tx
          .selectFrom('core.tenant')
          .select(['key_id', 'wrapped_data_key'])
          .where('id', '=', tenantId)
          .executeTakeFirstOrThrow();
        if (!tenant.key_id || !tenant.wrapped_data_key)
          throw new ServiceUnavailableException('tenant key is not available');
        credentials = JSON.parse(
          this.crypto
            .decrypt(
              tenantId,
              { keyId: tenant.key_id, wrappedDataKey: tenant.wrapped_data_key },
              { keyId: row.key_id, ciphertext: row.ciphertext },
              CREDENTIAL_PURPOSE,
            )
            .toString('utf8'),
        );
      }
      return { source, credentials };
    });
    if (!loaded) throw new NotFoundException();
    const connector = this.registry.get(loaded.source.type);
    if (!connector) throw new ConflictException('this connector is no longer available');
    return {
      connector,
      dataSourceId: loaded.source.id,
      ctx: {
        tenantId,
        dataSourceId: loaded.source.id,
        config: loaded.source.connection,
        credentials: loaded.credentials,
        deadline: Date.now() + CALL_BUDGET_MS,
      },
    };
  }
}
