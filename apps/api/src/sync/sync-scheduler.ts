import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, sql } from '../platform/database/database.module';
import { SyncQueue } from './sync-queue';

/**
 * How often a source type is synchronized on a timetable, in minutes (docs/data/sync-engine.md).
 * A type that is absent is not scheduled: an Excel source syncs when a file is uploaded.
 * Initial values, to tune during pilots.
 */
export const SYNC_INTERVAL_MINUTES: Readonly<Record<string, number>> = { postgresql: 15 };

/** Starts the syncs that are due for one tenant (ADR-0017). Runs as `bp_app` under RLS. */
@Injectable()
export class SyncScheduler {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SyncQueue) private readonly queue: SyncQueue,
  ) {}

  /** Sources of this tenant that have an active mapping, are not failing, and have not synced lately. */
  async dueSources(tenantId: string, now = Date.now()): Promise<string[]> {
    const rows = await this.db.tenantTx(
      tenantId,
      async (tx) =>
        (
          await sql<{ id: string; type: string; last_started: Date | null; running: boolean }>`
          SELECT ds.id, ds.type,
                 (SELECT max(r.started_at) FROM core.sync_run r WHERE r.data_source_id = ds.id) AS last_started,
                 EXISTS (SELECT 1 FROM core.sync_run r WHERE r.data_source_id = ds.id AND r.status = 'running') AS running
            FROM core.data_source ds
           WHERE ds.access_mode = 'managed_sync' AND ds.status NOT IN ('error', 'disabled')
             AND EXISTS (SELECT 1 FROM core.entity_mapping m
                          WHERE m.data_source_id = ds.id AND m.status = 'active')`.execute(tx)
        ).rows,
    );
    return rows
      .filter((r) => {
        const minutes = SYNC_INTERVAL_MINUTES[r.type];
        if (minutes === undefined || r.running) return false;
        return r.last_started === null || now - r.last_started.getTime() >= minutes * 60_000;
      })
      .map((r) => r.id);
  }

  async scheduleTenant(tenantId: string): Promise<number> {
    const due = await this.dueSources(tenantId);
    for (const dataSourceId of due)
      await this.queue.enqueue({ tenantId, dataSourceId, trigger: 'schedule' });
    return due.length;
  }
}
