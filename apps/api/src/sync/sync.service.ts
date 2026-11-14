import { Inject, Injectable } from '@nestjs/common';
import {
  AuthError,
  ConnectorError,
  PermissionError,
  TransientError,
} from '../connectors/connector';
import type { SourceRow } from '../connectors/connector';
import { DataSourceService } from '../connectors/data-source.service';
import { ENTITIES, findEntity } from '../mapping/canonical-catalog';
import type { MappingDocument } from '../mapping/mapping-document';
import { DatabaseService, sql, type Tx } from '../platform/database/database.module';
import { RowError, transformRow, type TransformedRow } from './transform';

// Managed sync, full snapshot (E5.1, docs/data/sync-engine.md). Each batch is one transaction in
// which the rows, the dead letters, the checkpoint, the dataset version and the outbox event are
// written together, so a crash leaves either all of a batch or none of it. Re-running a sync
// changes nothing: rows are keyed by source key and skipped when their content hash is equal.
// Incremental reads, delete propagation and drift detection are later epics (E5.2, E5.3).

export const SYNC_BUDGET_MS = 30 * 60_000;
const MAX_BATCH = 500;
const PARAM_LIMIT = 60_000;

export type SyncTrigger = 'manual' | 'schedule' | 'upload' | 'activation';
export type RunStatus = 'succeeded' | 'partially_failed' | 'failed';

export interface ObjectStats {
  rows_read: number;
  rows_changed: number;
  rows_failed: number;
  unresolved_refs: number;
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

const ORDER = new Map(ENTITIES.map((e, i) => [e.name, i]));
const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

interface RefRequest {
  entity: string;
  key: string;
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DataSourceService) private readonly sources: DataSourceService,
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
      if (mappings.length === 0) throw new SyncNotPossibleError('no active mapping');
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
    for (const mapping of mappings) {
      const stats: ObjectStats = {
        rows_read: 0,
        rows_changed: 0,
        rows_failed: 0,
        unresolved_refs: 0,
      };
      objects[mapping.source_object] = stats;
      await this.touchDataset(tenantId, dataSourceId, mapping.canonical_entity, 'attempt');
      try {
        await this.syncObject(
          tenantId,
          dataSourceId,
          runId,
          mapping,
          stats,
          (cols, size, onBatch) =>
            connector.readSnapshot(ctx, mapping.source_object, cols, size, onBatch),
        );
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
    const status: RunStatus =
      failedObjects === all.length
        ? 'failed'
        : failedObjects > 0 || all.some((s) => s.rows_failed > 0)
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
      if (fatal instanceof AuthError || fatal instanceof PermissionError)
        await tx
          .updateTable('core.data_source')
          .set({ status: 'error' })
          .where('id', '=', dataSourceId)
          .execute();
    });
    // A transient failure is rethrown after the run is recorded, so the queue can retry it.
    if (fatal instanceof TransientError) throw fatal;
    return { runId, status, objects };
  }

  private async touchDataset(
    tenantId: string,
    dataSourceId: string,
    entity: string,
    phase: 'attempt' | 'success' | 'failure',
  ): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      if (phase === 'attempt') {
        await sql`INSERT INTO core.dataset (tenant_id, data_source_id, canonical_entity, last_attempt_at)
          VALUES (${tenantId}, ${dataSourceId}, ${entity}, now())
          ON CONFLICT (tenant_id, data_source_id, canonical_entity) DO UPDATE SET last_attempt_at = now()`.execute(
          tx,
        );
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

  private async syncObject(
    tenantId: string,
    dataSourceId: string,
    runId: string,
    mapping: MappingDocument,
    stats: ObjectStats,
    read: (
      columns: string[],
      batchSize: number,
      onBatch: (rows: SourceRow[]) => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    const entity = findEntity(mapping.canonical_entity);
    if (!entity) throw new SyncNotPossibleError('unknown entity');
    // Column names are taken from the catalog, never from the mapping text.
    const targets = mapping.field_mappings
      .filter((f) => !f.target.startsWith('ext.'))
      .map((f) => entity.attributes.find((a) => a.name === f.target)?.name)
      .filter((n): n is string => n !== undefined);
    const sourceColumns = [
      ...new Set([
        ...mapping.key_fields,
        ...mapping.field_mappings.flatMap((f) => (f.source !== undefined ? [f.source] : [])),
      ]),
    ];
    const size = Math.max(1, Math.min(MAX_BATCH, Math.floor(PARAM_LIMIT / (targets.length + 6))));

    await read(sourceColumns, size, async (rows) => {
      stats.rows_read += rows.length;
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
        await sql`INSERT INTO core.sync_checkpoint (tenant_id, data_source_id, source_object, cursor, last_run_id)
          VALUES (${tenantId}, ${dataSourceId}, ${mapping.source_object}, ${JSON.stringify({ mode: 'snapshot', rows_read: stats.rows_read })}::jsonb, ${runId})
          ON CONFLICT (tenant_id, data_source_id, source_object)
          DO UPDATE SET cursor = EXCLUDED.cursor, last_run_id = EXCLUDED.last_run_id, updated_at = now()`.execute(
          tx,
        );
      });
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
  return 'internal_error';
}
