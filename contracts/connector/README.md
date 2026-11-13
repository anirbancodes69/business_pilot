# Connector contract (draft v0)

Decision: [ADR-0004](../../docs/adr/ADR-0004-connector-architecture.md). Capabilities per source: [docs/data/connector-capabilities.md](../../docs/data/connector-capabilities.md).

Connectors are stateless NestJS providers. Every call receives a `ConnectorCallContext`: `tenant_id`, `data_source_id`, validated `config`, decrypted `credentials` (in memory only), `deadline` and `logger`. The logger is pre-scrubbed, so secrets are redacted.

```ts
// Illustrative TypeScript signature. Milestone 4 implements capabilities, testConnection and
// discoverSchema only (apps/api/src/connectors/). readSnapshot, readChanges and listKeys arrive
// with the sync engine (Milestone 5). The call context has no logger yet: connectors do not log.
interface Connector {
  readonly type: 'excel' | 'google_sheets' | 'postgresql' | 'mysql' | 'mongodb' | string;
  describeCapabilities(): ConnectorCapabilities;                 // connector-capabilities.schema.json
  testConnection(ctx): Promise<ConnectionTestResult>;           // ok, errors[], privilege_warnings[]
  discoverSchema(ctx): Promise<DiscoveredSchema>;               // objects[], fields[], keys, stats, fingerprint
  readSnapshot(ctx, object: ObjectRef, opts: { batchSize: number }): AsyncIterable<RecordBatch>;
  readChanges(ctx, object: ObjectRef, checkpoint: Checkpoint): AsyncIterable<ChangeBatch>; // upserts[], deletes[], nextCheckpoint
  listKeys(ctx, object: ObjectRef): AsyncIterable<SourceKey[]>;
  executeFederated?(ctx, query: CompiledSourceQuery): Promise<ResultSet>; // read-only, compiler-generated only
}
```

## Semantics

- `RecordBatch.records[]`: `{ source_key: string, values: Record<string, unknown>, source_updated_at?: string }`. `source_key` is a stable string encoding of the key field(s).
- `Checkpoint`: opaque JSON owned by the connector, persisted by the sync engine. It must be monotonic and resumable.
- `ChangeBatch.nextCheckpoint` is persisted **only** after the batch commits.
- Errors are typed: `AuthError`, `PermissionError`, `TransientError` (retryable, optional `retryAfterMs`), `SchemaError`, `DataError` (per record). Messages must not contain credentials or row values.
- Connectors must not write to sources.
