import { z } from 'zod';

// Connector interface (E4.1, ADR-0004, contracts/connector/). Connectors are stateless: every call
// receives configuration and decrypted credentials. Only the operations needed by Milestone 4
// (capabilities, connection test, schema discovery) existed in Milestone 4. readSnapshot arrived
// with the sync engine (Milestone 5). readChanges and listKeys follow with incremental sync.

export const capabilitiesSchema = z.strictObject({
  connector_type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  connector_version: z.string(),
  access_modes: z.array(z.enum(['managed_sync', 'live_federated'])).min(1),
  change_detection: z
    .array(
      z.enum([
        'cdc_logical_replication',
        'cdc_binlog',
        'cdc_change_streams',
        'timestamp_cursor',
        'file_modified_time',
        'row_fingerprint',
        'full_snapshot_only',
      ]),
    )
    .min(1),
  delete_detection: z
    .array(z.enum(['native_cdc', 'fingerprint_diff', 'key_set_reconciliation', 'none']))
    .min(1),
  schema_discovery: z.enum(['catalog', 'header_inference', 'sampling']),
  key_strategy: z.enum(['primary_key', 'document_id', 'user_selected_columns']),
  query_pushdown: z.enum(['none', 'sql', 'mongodb_aggregation']).default('none'),
  auth_methods: z
    .array(z.enum(['none', 'password', 'oauth2', 'connection_string', 'iam']))
    .optional(),
  prerequisites: z.array(z.string()).optional(),
  limits: z
    .strictObject({
      max_file_bytes: z.number().int().positive().optional(),
      max_rows_per_object: z.number().int().positive().optional(),
      rate_limit_per_minute: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ConnectorCapabilities = z.infer<typeof capabilitiesSchema>;

export interface ConnectorCallContext {
  tenantId: string;
  dataSourceId: string;
  /** Validated by the connector's own `parseConfig`. */
  config: unknown;
  /** Decrypted, in memory only. Never log or return it. */
  credentials: unknown;
  /** Absolute time (epoch ms) after which the call must stop. */
  deadline: number;
  /** Uploaded-file sources only: the bytes of the latest upload, read through the object storage port. */
  readUpload?: () => Promise<Buffer | undefined>;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Fixed, non-secret messages. */
  errors: string[];
  privilege_warnings: string[];
}

export interface DiscoveredField {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
}

export interface DiscoveredObject {
  name: string;
  kind: 'table' | 'sheet' | 'collection';
  fields: DiscoveredField[];
  /** A planner estimate for databases, the exact count for files. */
  estimated_rows: number | null;
  /** Files only: columns that are present and unique in every row, usable as a key. */
  key_candidates?: string[];
}

export interface DiscoveredSchema {
  objects: DiscoveredObject[];
  /** Stable hash of object and field names, types and keys, for drift detection (M5). */
  fingerprint: string;
}

export type SourceValue = string | number | boolean | Date | null | undefined;
export type SourceRow = Record<string, SourceValue>;

export interface Connector {
  readonly type: string;
  describeCapabilities(): ConnectorCapabilities;
  /** Throws a ConnectorConfigError for invalid, non-secret connection parameters. */
  parseConfig(config: unknown): unknown;
  /** Throws a ConnectorConfigError for invalid credentials. Absent credentials are allowed only for uploads. */
  parseCredentials(credentials: unknown): unknown;
  testConnection(ctx: ConnectorCallContext): Promise<ConnectionTestResult>;
  discoverSchema(ctx: ConnectorCallContext): Promise<DiscoveredSchema>;
  /**
   * Reads every row of one object (a full snapshot), in batches, and passes each batch to
   * `onBatch`. Only the named columns are read. Rows are in memory only and never logged. A
   * batch is awaited before the next one is read, so the caller controls the pace.
   */
  readSnapshot(
    ctx: ConnectorCallContext,
    object: string,
    columns: string[],
    batchSize: number,
    onBatch: (rows: SourceRow[]) => Promise<void>,
    options?: ReadOptions,
  ): Promise<void>;
}

export interface ReadOptions {
  /**
   * Incremental read: only rows whose `updatedAtField` is at or after `since` (an ISO timestamp),
   * in ascending order of that field. Connectors without a timestamp cursor ignore it and read
   * everything, which stays correct because the caller skips unchanged rows by content hash.
   */
  updatedAtField?: string;
  since?: string;
}

// Typed errors (contracts/connector/README.md). Messages never contain credentials or row values.
export class ConnectorError extends Error {}
export class ConnectorConfigError extends ConnectorError {
  constructor(readonly problems: string[]) {
    super('invalid connector configuration');
  }
}
export class AuthError extends ConnectorError {}
export class PermissionError extends ConnectorError {}
export class TransientError extends ConnectorError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export class SchemaError extends ConnectorError {}
/** The target host is not allowed (private network, metadata service, unresolvable). */
export class EgressDeniedError extends ConnectorError {}
