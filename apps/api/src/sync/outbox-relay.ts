import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, sql } from '../platform/database/database.module';
import { EventQueue } from './event-queue';

/** Event types that something consumes. Empty until M6 (cache) and M7 (indexing) add theirs. */
export const EVENT_SUBSCRIBERS = Symbol('EVENT_SUBSCRIBERS');

const BATCH = 100;
export const OUTBOX_RETENTION_DAYS = 7;

/**
 * Publishes one tenant's outbox events (ADR-0017). Runs as `bp_app` with the tenant's context.
 * Delivery is at least once: a crash after the queue add and before the commit publishes the same
 * event again with the same job id, which the queue ignores while the job exists. Event types with
 * no subscriber are marked published without being queued. Events only trigger work: correctness
 * rests on data_version and stored state, never on an event arriving.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventQueue) private readonly events: EventQueue,
    @Inject(EVENT_SUBSCRIBERS) private readonly subscribed: ReadonlySet<string>,
  ) {}

  /** Returns how many events were marked published. */
  async relayTenant(tenantId: string): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.db.tenantTx(tenantId, async (tx) => {
        const rows = await sql<{
          id: string;
          type: string;
          aggregate_ref: string;
          payload: unknown;
        }>`SELECT id, type, aggregate_ref, payload FROM core.outbox_event
            WHERE published_at IS NULL ORDER BY created_at, id
            LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`.execute(tx);
        for (const e of rows.rows)
          if (this.subscribed.has(e.type))
            await this.events.publish({
              eventId: e.id,
              tenantId,
              type: e.type,
              aggregateRef: e.aggregate_ref,
              payload: e.payload,
            });
        if (rows.rows.length > 0)
          await sql`UPDATE core.outbox_event SET published_at = now()
            WHERE id = ANY(${rows.rows.map((r) => r.id)}::uuid[])`.execute(tx);
        return rows.rows.length;
      });
      total += n;
      if (n < BATCH) break;
    }
    await this.db.tenantTx(tenantId, (tx) =>
      sql`DELETE FROM core.outbox_event WHERE published_at IS NOT NULL
            AND published_at < now() - ${`${OUTBOX_RETENTION_DAYS} days`}::interval`.execute(tx),
    );
    return total;
  }
}
