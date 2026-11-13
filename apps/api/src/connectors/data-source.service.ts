import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ENVELOPE_TOKEN } from '../platform/crypto/crypto.module';
import type { EnvelopeCrypto } from '../platform/crypto/envelope';
import { DatabaseService } from '../platform/database/database.module';
import {
  OBJECT_STORAGE_TOKEN,
  type ObjectStorage,
} from '../platform/object-storage/object-storage';
import {
  type Connector,
  type ConnectorCallContext,
  ConnectorConfigError,
  ConnectorError,
  type DiscoveredSchema,
  SchemaError,
} from './connector';
import { ConnectorRegistry } from './connector-registry';

export const CALL_BUDGET_MS = 30_000;
export const CREDENTIAL_PURPOSE = 'connector_credential';

/** Loads a data source with its decrypted credentials and runs connector calls for it. */
@Injectable()
export class DataSourceService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(ENVELOPE_TOKEN) private readonly crypto: EnvelopeCrypto | null,
    @Inject(OBJECT_STORAGE_TOKEN) private readonly storage: ObjectStorage,
  ) {}

  /** Runs discovery for a stored data source. Metadata only, no row values. */
  async discover(
    tenantId: string,
    id: string,
  ): Promise<{ schema: DiscoveredSchema; dataSourceId: string }> {
    const { connector, ctx, dataSourceId } = await this.prepare(tenantId, id);
    try {
      return { schema: await connector.discoverSchema(ctx), dataSourceId };
    } catch (error) {
      if (error instanceof ConnectorConfigError)
        throw new UnprocessableEntityException('the stored configuration is invalid');
      if (error instanceof SchemaError) throw new UnprocessableEntityException(error.message);
      if (error instanceof ConnectorError)
        throw new ServiceUnavailableException(`schema discovery failed: ${error.message}`);
      throw error;
    }
  }

  private async latestUpload(tenantId: string, dataSourceId: string): Promise<Buffer | undefined> {
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.data_source_upload')
        .select('object_key')
        .where('data_source_id', '=', dataSourceId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    return row ? this.storage.get(tenantId, row.object_key) : undefined;
  }

  /** Loads the data source and decrypts its credentials in memory for one call. */
  async prepare(
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
        readUpload: () => this.latestUpload(tenantId, loaded.source.id),
      },
    };
  }
}
