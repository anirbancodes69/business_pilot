import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  AuthError,
  ConnectorError,
  PermissionError,
  TransientError,
  type DiscoveredSchema,
  type ReadOptions,
  type SourceRow,
} from '../connectors/connector';
import { DataSourceService } from '../connectors/data-source.service';
import { ENTITIES, findEntity } from '../mapping/canonical-catalog';
import type { MappingDocument } from '../mapping/mapping-document';
import { DatabaseService, sql, type Tx } from '../platform/database/database.module';
import { TaskQueue } from './task-queue';
import { detectDrift, mappedColumns, mappingHash } from './drift';
import { RowError, sourceKeyOf, transformRow, type TransformedRow } from './transform';

// Managed sync, full snapshot (E5.1, docs/data/sync-engine.md). Each batch is one transaction in
// which the rows, the dead letters, the checkpoint, the dataset version and the outbox event are
// written together, so a crash leaves either all of a batch or none of it. Re-running a sync
// changes nothing: rows are keyed by source key and skipped when their content hash is equal.
// Incremental reads use a timestamp cursor when the mapping names an updated_at field (E5.2).
// Deleted source rows are found by key-set reconciliation (E5.3). A breaking schema change pauses
// the object and moves its mapping to needs_review. Retries and the outbox relay are E5.4, E5.5.

export const SYNC_BUDGET_MS = 30 * 60_000;
const MAX_BATCH = 500;
const PARAM_LIMIT = 60_000;

export type SyncTrigger = 'manual' | 'schedule' | 'upload' | 'activation';
export type RunStatus = 'succeeded' | 'partially_failed' | 'failed' | 'paused';
/** Keys are re-listed at the source at most this often during incremental runs. */
export const RECONCILE_EVERY_MS = 24 * 3_600_000;

export interface ObjectStats {
  rows_read: number;
  rows_changed: number;
  rows_failed: number;
  rows_deleted: number;
  unresolved_refs: number;
  mode: 'full' | 'incremental';
  schema_warnings: number;
  paused?: string[];
  error_code?: string;
}

export interface SyncResult {
  runId: string;
  status: RunStatus;
  objects: Record<string, ObjectStats>;
}

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super('a sync is already running for this data source');
  }
}
export class SyncNotPossibleError extends Error {}
/** Normal before a mapping is activated (an upload comes first): a skipped job, not a failure. */
export class NoActiveMappingError extends SyncNotPossibleError {
  constructor() {
    super('no active mapping');
  }
}
/** A full read returned no rows although rows are stored: refused, so an outage cannot wipe data. */
export class SourceEmptyError extends Error {}

const ORDER = new Map(ENTITIES.map((e, i) => [e.name, i]));
const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** Stored in `core.sync_checkpoint.cursor`. Names and timestamps only. */
interface Cursor {
  mode?: 'snapshot' | 'incremental';
  mapping_hash?: string;
  updated_at?: string;
  reconciled_at?: string;
  columns?: Record<string, string>;
  rows_read?: number;
}

interface RefRequest {
  entity: string;
  key: string;
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DataSourceService) private readonly sources: DataSourceService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TaskQueue) private readonly tasks?: TaskQueue,
  ) {}

  async run(tenantId: string, dataSourceId: string, trigger: SyncTrigger): Promise<SyncResult> {
    const { connector, ctx } = await this.sources.prepare(tenantId, dataSourceId);
    ctx.deadline = Date.now() + SYNC_BUDGET_MS;

    const started = await this.db.tenantTx(tenantId, async (tx) => {
      const source = await tx
        .selectFrom('core.data_source')
        .select(['status', 'access_mode'])
        .where('id', '=', dataSourceId)
        .executeTakeFirstOrThrow();
      if (source.status === 'disabled' || source.access_mode !== 'managed_sync')
        throw new SyncNotPossibleError('the data source cannot be synchronized');
      const mappings = await tx
        .selectFrom('core.entity_mapping')
        .select('document')
        .where('data_source_id', '=', dataSourceId)
        .where('status', '=', 'active')
        .execute();
      if (mappings.length === 0) throw new NoActiveMappingError();
      // A worker that died mid-run leaves a run that is still marked running: release the source.
      await sql`UPDATE core.sync_run SET status = 'failed', finished_at = now(), error_code = 'abandoned'
        WHERE data_source_id = ${dataSourceId} AND status = 'running'
          AND started_at < now() - ${`${SYNC_BUDGET_MS * 2} milliseconds`}::interval`.execute(tx);
      try {
        const run = await tx
          .insertInto('core.sync_run')
          .values({ tenant_id: tenantId, data_source_id: dataSourceId, trigger })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { runId: run.id, mappings: mappings.map((m) => m.document as MappingDocument) };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new SyncAlreadyRunningError();
        throw error;
      }
    });
    const { runId } = started;
    // Parents first, so references to them can be resolved in the same run.
    const mappings = started.mappings.sort(
      (a, b) => (ORDER.get(a.canonical_entity) ?? 99) - (ORDER.get(b.canonical_entity) ?? 99),
    );

    const objects: Record<string, ObjectStats> = {};
    let fatal: unknown;
    let discovered: DiscoveredSchema | undefined;
    try {
      discovered = await connector.discoverSchema(ctx);
    } catch (error) {
      fatal = error instanceof ConnectorError ? error : new TransientError('discovery failed');
    }
    const perEntity = new Map<string, number>();
    for (const m of mappings)
      perEntity.set(m.canonical_entity, (perEntity.get(m.canonical_entity) ?? 0) + 1);
    const checkTypes = connector.describeCapabilities().schema_discovery === 'catalog';
    const canCursor = connector
      .describeCapabilities()
      .change_detection.includes('timestamp_cursor');

    for (const mapping of fatal ? [] : mappings) {
      const stats: ObjectStats = {
        rows_read: 0,
        rows_changed: 0,
        rows_failed: 0,
        rows_deleted: 0,
        unresolved_refs: 0,
        mode: 'full',
        schema_warnings: 0,
      };
      objects[mapping.source_object] = stats;
      await this.touchDataset(tenantId, dataSourceId, mapping.canonical_entity, 'attempt');
      try {
        const checkpoint = await this.db.tenantTx(tenantId, (tx) =>
          tx
            .selectFrom('core.sync_checkpoint')
            .select('cursor')
            .where('data_source_id', '=', dataSourceId)
            .where('source_object', '=', mapping.source_object)
            .executeTakeFirst(),
        );
        const previous = (checkpoint?.cursor ?? {}) as Cursor;
        const drift = detectDrift(
          mapping,
          discovered?.objects.find((o) => o.name === mapping.source_object),
          previous.columns,
          checkTypes,
        );
        stats.schema_warnings = drift.additive;
        if (drift.breaking.length > 0) {
          stats.paused = drift.breaking;
          await this.pause(tenantId, dataSourceId, mapping, drift.breaking);
          continue;
        }
        await this.syncObject({
          tenantId,
          dataSourceId,
          runId,
          mapping,
          stats,
          previous,
          columns: drift.columns,
          canCursor,
          // Two objects feeding one entity cannot be told apart in the store, so no deletes then.
          mayDelete: perEntity.get(mapping.canonical_entity) === 1,
          read: (cols, size, onBatch, options) =>
            connector.readSnapshot(ctx, mapping.source_object, cols, size, onBatch, options),
        });
        await this.touchDataset(tenantId, dataSourceId, mapping.canonical_entity, 'success');
      } catch (error) {
        stats.error_code = errorCode(error);
        await this.touchDataset(tenantId, dataSourceId, mapping.canonical_entity, 'failure');
        if (error instanceof AuthError || error instanceof PermissionError) {
          fatal = error; // retrying cannot help: stop the run
          break;
        }
        if (error instanceof TransientError) fatal = error;
      }
    }

    const all = Object.values(objects);
    const failedObjects = all.filter((s) => s.error_code !== undefined).length;
    const pausedObjects = all.filter((s) => s.paused !== undefined).length;
    const status: RunStatus =
      fatal && all.length === 0
        ? 'failed'
        : pausedObjects === all.length && all.length > 0
          ? 'paused'
          : failedObjects === all.length
            ? 'failed'
            : failedObjects > 0 || pausedObjects > 0 || all.some((s) => s.rows_failed > 0)
              ? 'partially_failed'
              : 'succeeded';
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .updateTable('core.sync_run')
        .set({
          status,
          finished_at: new Date(),
          stats: JSON.stringify(objects),
          error_code: fatal ? errorCode(fatal) : null,
        })
        .where('id', '=', runId)
        .execute();
      const kind =
        fatal instanceof AuthError || fatal instanceof PermissionError
          ? 'sync.auth_failed'
          : status === 'failed' && !(fatal instanceof TransientError)
            ? 'sync.failed'
            : undefined;
      if (fatal instanceof AuthError || fatal instanceof PermissionError)
        await tx
          .updateTable('core.data_source')
          .set({ status: 'error' })
          .where('id', '=', dataSourceId)
          .execute();
      if (kind)
        await tx
          .insertInto('core.notification')
          .values({
            tenant_id: tenantId,
            kind,
            severity: kind === 'sync.auth_failed' ? 'critical' : 'warning',
            data_source_id: dataSourceId,
            metadata: JSON.stringify({
              run_id: runId,
              error_code: fatal ? errorCode(fatal) : 'all_objects_failed',
            }),
          })
          .execute();
    });
    // Fast path for the outbox (ADR-0017): the sweeper is the safety net if this is lost.
    if (all.some((s) => s.rows_changed > 0 || s.rows_deleted > 0))
      await this.tasks?.enqueueQuietly({ kind: 'relay', tenantId });
    // A transient failure is rethrown after the run is recorded, so the queue can retry it.
    if (fatal instanceof TransientError) throw fatal;
    return { runId, status, objects };
  }

  private async touchDataset(
    tenantId: string,
    dataSourceId: string,
    entity: string,
    phase: 'attempt' | 'success' | 'failure' | 'paused',
  ): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      if (phase === 'attempt') {
        await sql`INSERT INTO core.dataset (tenant_id, data_source_id, canonical_entity, last_attempt_at)
          VALUES (${tenantId}, ${dataSourceId}, ${entity}, now())
          ON CONFLICT (tenant_id, data_source_id, canonical_entity) DO UPDATE SET last_attempt_at = now()`.execute(
          tx,
        );
      } else if (phase === 'paused') {
        await sql`UPDATE core.dataset SET status = 'paused'
          WHERE data_source_id = ${dataSourceId} AND canonical_entity = ${entity}`.execute(tx);
      } else if (phase === 'failure') {
        await sql`UPDATE core.dataset SET status = 'failed'
          WHERE data_source_id = ${dataSourceId} AND canonical_entity = ${entity}`.execute(tx);
      } else {
        const table = sql.raw(`analytics.${quote(entity)}`);
        await sql`UPDATE core.dataset SET status = 'fresh', last_successful_sync_at = now(),
            row_count = (SELECT count(*) FROM ${table} WHERE data_source_id = ${dataSourceId} AND deleted_at IS NULL)
          WHERE data_source_id = ${dataSourceId} AND canonical_entity = ${entity}`.execute(tx);
      }
    });
  }

  /** A breaking change: stop syncing this object until a person has reviewed the mapping. */
  private async pause(
    tenantId: string,
    dataSourceId: string,
    mapping: MappingDocument,
    problems: string[],
  ): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .updateTable('core.entity_mapping')
        .set({ status: 'needs_review', updated_at: new Date() })
        .where('data_source_id', '=', dataSourceId)
        .where('source_object', '=', mapping.source_object)
        .where('status', '=', 'active')
        .execute();
      await sql`UPDATE core.dataset SET status = 'paused'
        WHERE data_source_id = ${dataSourceId} AND canonical_entity = ${mapping.canonical_entity}`.execute(
        tx,
      );
      // The alert for the administrator: an audit event now, a notification when those exist.
      await this.audit.record(tx, {
        tenantId,
        actorId: null,
        action: 'sync.paused_schema_drift',
        target: dataSourceId,
        metadata: { source_object: mapping.source_object, problems },
      });
      await tx
        .insertInto('core.notification')
        .values({
          tenant_id: tenantId,
          kind: 'sync.paused_schema_drift',
          severity: 'warning',
          data_source_id: dataSourceId,
          metadata: JSON.stringify({ source_object: mapping.source_object, problems }),
        })
        .execute();
    });
  }

  private async syncObject(o: {
    tenantId: string;
    dataSourceId: string;
    runId: string;
    mapping: MappingDocument;
    stats: ObjectStats;
    previous: Cursor;
    columns: Record<string, string>;
    canCursor: boolean;
    mayDelete: boolean;
    read: (
      columns: string[],
      batchSize: number,
      onBatch: (rows: SourceRow[]) => Promise<void>,
      options?: ReadOptions,
    ) => Promise<void>;
  }): Promise<void> {
    const { tenantId, dataSourceId, runId, mapping, stats, previous } = o;
    const entity = findEntity(mapping.canonical_entity);
    if (!entity) throw new SyncNotPossibleError('unknown entity');
    // Column names are taken from the catalog, never from the mapping text.
    const targets = mapping.field_mappings
      .filter((f) => !f.target.startsWith('ext.'))
      .map((f) => entity.attributes.find((a) => a.name === f.target)?.name)
      .filter((n): n is string => n !== undefined);
    const sourceColumns = mappedColumns(mapping);
    const size = Math.max(1, Math.min(MAX_BATCH, Math.floor(PARAM_LIMIT / (targets.length + 6))));

    const hash = mappingHash(mapping);
    const field = mapping.updated_at_field;
    // Incremental only with a trusted cursor from a complete run of this same mapping.
    const incremental =
      o.canCursor &&
      field !== undefined &&
      previous.mode === 'incremental' &&
      previous.mapping_hash === hash &&
      typeof previous.updated_at === 'string';
    stats.mode = incremental ? 'incremental' : 'full';
    let cursorAt = incremental ? previous.updated_at : undefined;
    const seen = new Set<string>();

    const cursorOf = (mode: Cursor['mode'], reconciledAt: string | undefined): Cursor => ({
      mode,
      mapping_hash: hash,
      columns: o.columns,
      ...(cursorAt !== undefined ? { updated_at: cursorAt } : {}),
      ...(reconciledAt !== undefined ? { reconciled_at: reconciledAt } : {}),
      rows_read: stats.rows_read,
    });
    const saveCheckpoint = (tx: Tx, cursor: Cursor): Promise<unknown> =>
      sql`INSERT INTO core.sync_checkpoint (tenant_id, data_source_id, source_object, cursor, last_run_id)
        VALUES (${tenantId}, ${dataSourceId}, ${mapping.source_object}, ${JSON.stringify(cursor)}::jsonb, ${runId})
        ON CONFLICT (tenant_id, data_source_id, source_object)
        DO UPDATE SET cursor = EXCLUDED.cursor, last_run_id = EXCLUDED.last_run_id, updated_at = now()`.execute(
        tx,
      );

    await o.read(
      sourceColumns,
      size,
      async (rows) => {
        stats.rows_read += rows.length;
        // A row whose key can be read counts as present at the source, even if it fails later.
        if (!incremental)
          for (const row of rows)
            try {
              seen.add(sourceKeyOf(row, mapping.key_fields));
            } catch {
              /* no usable key: it cannot be in the store either */
            }
        if (field !== undefined)
          for (const row of rows) {
            const v = row[field];
            const iso = v instanceof Date ? v.toISOString() : undefined;
            if (iso !== undefined && (cursorAt === undefined || iso > cursorAt)) cursorAt = iso;
          }
        await this.db.tenantTx(tenantId, async (tx) => {
          const refs = await this.resolveRefs(tx, dataSourceId, mapping, rows);
          const good = new Map<string, TransformedRow>();
          const dead: { key: string | null; field: string | null; code: string }[] = [];
          for (const row of rows) {
            try {
              const out = transformRow(row, mapping, (e, k) => refs.get(`${e}\u0000${k}`) ?? null);
              if (good.has(out.sourceKey))
                dead.push({ key: out.sourceKey, field: null, code: 'duplicate_key' });
              good.set(out.sourceKey, out);
              stats.unresolved_refs += out.unresolvedRefs.length;
            } catch (error) {
              if (!(error instanceof RowError)) throw error;
              dead.push({ key: null, field: error.field, code: error.code });
            }
          }
          stats.rows_failed += dead.length;
          for (const d of dead)
            await tx
              .insertInto('core.sync_dead_letter')
              .values({
                tenant_id: tenantId,
                run_id: runId,
                data_source_id: dataSourceId,
                source_object: mapping.source_object,
                source_key: d.key,
                field: d.field,
                error_code: d.code,
              })
              .execute();
          let changed = 0;
          if (good.size > 0)
            changed = await this.upsert(
              tx,
              tenantId,
              dataSourceId,
              mapping.canonical_entity,
              targets,
              [...good.values()],
            );
          stats.rows_changed += changed;
          if (changed > 0)
            await this.bumpVersion(tx, tenantId, dataSourceId, runId, mapping.canonical_entity);
          // While a full read is in progress the cursor stays "snapshot": it is trusted only at the end.
          await saveCheckpoint(
            tx,
            cursorOf(incremental ? 'incremental' : 'snapshot', previous.reconciled_at),
          );
        });
      },
      incremental && field !== undefined && cursorAt !== undefined
        ? { updatedAtField: field, since: cursorAt }
        : undefined,
    );

    // Deleted rows: a full read lists every key already. An incremental run lists keys separately,
    // but only when the last reconciliation is old.
    let reconciledAt = previous.reconciled_at;
    const stale =
      reconciledAt === undefined || Date.now() - Date.parse(reconciledAt) > RECONCILE_EVERY_MS;
    if (o.mayDelete && (!incremental || stale)) {
      if (incremental)
        await o.read(mapping.key_fields, MAX_BATCH, (rows) => {
          for (const row of rows)
            try {
              seen.add(sourceKeyOf(row, mapping.key_fields));
            } catch {
              /* unusable key */
            }
          return Promise.resolve();
        });
      stats.rows_deleted = await this.reconcile(tenantId, dataSourceId, runId, mapping, seen);
      reconciledAt = new Date().toISOString();
    }
    // The read finished: from now on the next run may start from the cursor.
    await this.db.tenantTx(tenantId, async (tx) => {
      await saveCheckpoint(
        tx,
        cursorOf(o.canCursor && field !== undefined ? 'incremental' : 'snapshot', reconciledAt),
      );
    });
  }

  /** Marks stored rows that the source no longer has as deleted, once per run (key-set reconciliation). */
  private async reconcile(
    tenantId: string,
    dataSourceId: string,
    runId: string,
    mapping: MappingDocument,
    seen: Set<string>,
  ): Promise<number> {
    const table = sql.raw(`analytics.${quote(mapping.canonical_entity)}`);
    return this.db.tenantTx(tenantId, async (tx) => {
      if (seen.size === 0) {
        const live = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${table}
          WHERE data_source_id = ${dataSourceId} AND deleted_at IS NULL`.execute(tx);
        if (Number(live.rows[0]?.n ?? 0) > 0) throw new SourceEmptyError();
        return 0;
      }
      const res = await sql`UPDATE ${table} SET deleted_at = now(), synced_at = now()
        WHERE data_source_id = ${dataSourceId} AND deleted_at IS NULL
          AND source_key <> ALL(${[...seen]}::text[])
        RETURNING id`.execute(tx);
      if (res.rows.length > 0)
        await this.bumpVersion(tx, tenantId, dataSourceId, runId, mapping.canonical_entity);
      return res.rows.length;
    });
  }

  /** Looks up the canonical ids of referenced rows. Two passes: first collect, then resolve. */
  private async resolveRefs(
    tx: Tx,
    dataSourceId: string,
    mapping: MappingDocument,
    rows: SourceRow[],
  ): Promise<Map<string, string>> {
    const wanted = new Map<string, RefRequest>();
    for (const row of rows) {
      try {
        transformRow(row, mapping, (entity, key) => {
          wanted.set(`${entity}\u0000${key}`, { entity, key });
          return null;
        });
      } catch {
        // Bad rows are reported by the real pass.
      }
    }
    const byEntity = new Map<string, string[]>();
    for (const r of wanted.values()) {
      if (!findEntity(r.entity)) continue;
      byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r.key]);
    }
    const found = new Map<string, string>();
    for (const [entity, keys] of byEntity) {
      const table = sql.raw(`analytics.${quote(entity)}`);
      // Prefer a row from the same source when several sources hold the same key.
      const res = await sql<{ source_key: string; id: string }>`
        SELECT DISTINCT ON (source_key) source_key, id FROM ${table}
         WHERE source_key = ANY(${keys}::text[]) AND deleted_at IS NULL
         ORDER BY source_key, (data_source_id = ${dataSourceId}) DESC, synced_at DESC`.execute(tx);
      for (const r of res.rows) found.set(`${entity}\u0000${r.source_key}`, r.id);
    }
    return found;
  }

  private async upsert(
    tx: Tx,
    tenantId: string,
    dataSourceId: string,
    entity: string,
    targets: string[],
    rows: TransformedRow[],
  ): Promise<number> {
    const table = sql.raw(`analytics.${quote(entity)}`);
    const cols = sql.raw(targets.map(quote).join(', '));
    const updates = sql.raw(targets.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', '));
    const values = rows.map(
      (r) =>
        sql`(${tenantId}, ${dataSourceId}, ${r.sourceKey}, ${r.contentHash}, ${sql.join(
          targets.map((c) => r.columns[c] ?? null),
        )}${targets.length > 0 ? sql`, ` : sql``}${JSON.stringify(r.ext)}::jsonb)`,
    );
    const result = await sql`
      INSERT INTO ${table} AS t (tenant_id, data_source_id, source_key, content_hash,
        ${cols}${targets.length > 0 ? sql`, ` : sql``}ext)
      VALUES ${sql.join(values)}
      ON CONFLICT (tenant_id, data_source_id, source_key) DO UPDATE
        SET content_hash = EXCLUDED.content_hash,
            ${updates}${targets.length > 0 ? sql`, ` : sql``}ext = EXCLUDED.ext,
            synced_at = now(), deleted_at = NULL
        WHERE t.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR t.deleted_at IS NOT NULL
      RETURNING t.id`.execute(tx);
    return result.rows.length;
  }

  /** Once per run and dataset: raises data_version and writes the outbox event (P-06). */
  private async bumpVersion(
    tx: Tx,
    tenantId: string,
    dataSourceId: string,
    runId: string,
    entity: string,
  ): Promise<void> {
    const res = await sql<{ data_version: string }>`
      UPDATE core.dataset SET data_version = data_version + 1, bumped_run_id = ${runId}
       WHERE data_source_id = ${dataSourceId} AND canonical_entity = ${entity}
         AND bumped_run_id IS DISTINCT FROM ${runId}::uuid
      RETURNING data_version`.execute(tx);
    const row = res.rows[0];
    if (!row) return;
    await tx
      .insertInto('core.outbox_event')
      .values({
        tenant_id: tenantId,
        type: 'dataset.version_changed',
        aggregate_ref: `dataset:${dataSourceId}:${entity}`,
        payload: JSON.stringify({
          data_source_id: dataSourceId,
          canonical_entity: entity,
          data_version: Number(row.data_version),
          run_id: runId,
        }),
      })
      .execute();
  }
}

/** A fixed code, never a message: messages can quote values. */
function errorCode(error: unknown): string {
  if (error instanceof AuthError) return 'auth_failed';
  if (error instanceof PermissionError) return 'permission_denied';
  if (error instanceof TransientError) return 'source_unavailable';
  if (error instanceof ConnectorError) return 'connector_error';
  if (error instanceof SyncNotPossibleError) return 'not_possible';
  if (error instanceof SourceEmptyError) return 'source_empty';
  return 'internal_error';
}
