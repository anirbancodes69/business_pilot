import { createHash } from 'node:crypto';
import { Client, type ClientConfig } from 'pg';
import { z } from 'zod';
import {
  AuthError,
  type ConnectionTestResult,
  type Connector,
  type ConnectorCallContext,
  type ConnectorCapabilities,
  ConnectorConfigError,
  type DiscoveredObject,
  type DiscoveredSchema,
  EgressDeniedError,
  PermissionError,
  TransientError,
} from '../connector';
import { resolveAllowedHost } from '../egress';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

const configSchema = z.strictObject({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  schema: z.string().regex(IDENT).default('public'),
  // 'disable' exists for a local development database only; it is refused unless private networks are allowed.
  tls_mode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('verify-full'),
});
export type PostgresConfig = z.infer<typeof configSchema>;

const credentialsSchema = z.strictObject({
  username: z.string().min(1).max(63),
  password: z.string().min(1).max(1024),
});
type PostgresCredentials = z.infer<typeof credentialsSchema>;

const CAPABILITIES: ConnectorCapabilities = {
  connector_type: 'postgresql',
  connector_version: '0.1.0',
  access_modes: ['managed_sync'],
  change_detection: ['timestamp_cursor', 'full_snapshot_only'],
  delete_detection: ['key_set_reconciliation'],
  schema_discovery: 'catalog',
  key_strategy: 'primary_key',
  query_pushdown: 'none',
  auth_methods: ['password'],
  prerequisites: [
    'A read-only user with SELECT on the approved tables only',
    'Network reachability from the published egress addresses',
    'TLS enabled on the server',
  ],
  limits: { max_rows_per_object: 50_000_000 },
};

function problems(error: z.ZodError): string[] {
  // Paths and codes only. Zod messages can echo the received value, which may be a secret.
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`);
}

/** Maps driver errors to typed errors with fixed messages (no host, user or value text). */
function mapError(error: unknown): Error {
  if (error instanceof EgressDeniedError) return error;
  const code = (error as { code?: string }).code ?? '';
  if (code === '28P01' || code === '28000') return new AuthError('authentication failed');
  if (code === '42501') return new PermissionError('insufficient privileges');
  if (code === '3D000') return new PermissionError('database not found or not accessible');
  if (code === '57014') return new TransientError('the source took too long to answer');
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'].includes(code))
    return new TransientError('the source could not be reached');
  if (/SSL|TLS|certificate/i.test(`${code} ${(error as Error).message ?? ''}`))
    return new TransientError('secure connection to the source failed');
  return new TransientError('the source returned an error');
}

export class PostgresConnector implements Connector {
  readonly type = 'postgresql';

  constructor(private readonly options: { allowPrivateNetworks: boolean }) {}

  describeCapabilities(): ConnectorCapabilities {
    return CAPABILITIES;
  }

  parseConfig(config: unknown): PostgresConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConnectorConfigError(problems(parsed.error));
    if (parsed.data.tls_mode === 'disable' && !this.options.allowPrivateNetworks)
      throw new ConnectorConfigError(['tls_mode: unsupported']);
    return parsed.data;
  }

  parseCredentials(credentials: unknown): PostgresCredentials {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new ConnectorConfigError(problems(parsed.error));
    return parsed.data;
  }

  /** Connects to a vetted address, read-only, with a statement timeout. */
  private async withClient<T>(
    ctx: ConnectorCallContext,
    fn: (client: Client, config: PostgresConfig) => Promise<T>,
  ): Promise<T> {
    const config = this.parseConfig(ctx.config);
    const creds = this.parseCredentials(ctx.credentials);
    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) throw new TransientError('the source took too long to answer');
    const address = await resolveAllowedHost(config.host, this.options.allowPrivateNetworks);

    const ssl: ClientConfig['ssl'] =
      config.tls_mode === 'disable'
        ? false
        : {
            // The connection goes to the vetted address, so the certificate is checked against the name.
            servername: config.host,
            rejectUnauthorized: config.tls_mode !== 'require',
            ...(config.tls_mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
          };
    const client = new Client({
      host: address,
      port: config.port,
      database: config.database,
      user: creds.username,
      password: creds.password,
      ssl,
      connectionTimeoutMillis: Math.min(remaining, 10_000),
      statement_timeout: Math.min(remaining, 30_000),
      query_timeout: Math.min(remaining, 30_000),
      application_name: 'businesspilot-connector',
    });
    // An idle-client error would otherwise be an unhandled event.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      const result = await fn(client, config);
      await client.query('ROLLBACK');
      return result;
    } catch (error) {
      throw mapError(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async testConnection(ctx: ConnectorCallContext): Promise<ConnectionTestResult> {
    try {
      return await this.withClient(ctx, async (client, config) => {
        const warnings: string[] = [];
        const role = await client.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
          `SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
        );
        if (role.rows[0]?.rolsuper) warnings.push('The user is a superuser. Use a read-only user.');
        const canCreate = await client.query<{ ok: boolean }>(
          `SELECT has_schema_privilege(current_user, $1, 'CREATE') AS ok`,
          [config.schema],
        );
        if (canCreate.rows[0]?.ok) warnings.push('The user can create objects in the schema.');
        const writable = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r','p')
              AND has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')`,
          [config.schema],
        );
        if (Number(writable.rows[0]?.n ?? 0) > 0)
          warnings.push('The user can change data in some tables. Grant SELECT only.');
        return { ok: true, errors: [], privilege_warnings: warnings };
      });
    } catch (error) {
      if (error instanceof AuthError || error instanceof PermissionError)
        return { ok: false, errors: [error.message], privilege_warnings: [] };
      if (error instanceof TransientError || error instanceof EgressDeniedError)
        return { ok: false, errors: [error.message], privilege_warnings: [] };
      throw error;
    }
  }

  async discoverSchema(ctx: ConnectorCallContext): Promise<DiscoveredSchema> {
    return this.withClient(ctx, async (client, config) => {
      // Only tables the user can read. Metadata only: no values and no samples are read.
      const columns = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        estimated_rows: number;
        is_pk: boolean;
      }>(
        `SELECT c.relname AS table_name, a.attname AS column_name,
                format_type(a.atttypid, a.atttypmod) AS data_type,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                c.reltuples::float8 AS estimated_rows,
                COALESCE(a.attnum = ANY (i.indkey), false) AS is_pk
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
          WHERE n.nspname = $1 AND c.relkind IN ('r','p')
            AND has_table_privilege(current_user, c.oid, 'SELECT')
          ORDER BY c.relname, a.attnum`,
        [config.schema],
      );
      const objects = new Map<string, DiscoveredObject>();
      for (const row of columns.rows) {
        let object = objects.get(row.table_name);
        if (!object) {
          object = {
            name: row.table_name,
            kind: 'table',
            fields: [],
            // reltuples is -1 for a table that was never analyzed.
            estimated_rows: row.estimated_rows >= 0 ? Math.round(row.estimated_rows) : null,
          };
          objects.set(row.table_name, object);
        }
        object.fields.push({
          name: row.column_name,
          data_type: row.data_type,
          nullable: row.is_nullable === 'YES',
          is_primary_key: row.is_pk,
        });
      }
      const list = [...objects.values()];
      const canonical = list.map((o) => [
        o.name,
        o.fields.map((f) => [f.name, f.data_type, f.nullable, f.is_primary_key]),
      ]);
      return {
        objects: list,
        fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
      };
    });
  }
}
