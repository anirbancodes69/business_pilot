import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/platform/config/env';
import { SystemDatabase } from '../../src/platform/database/system-database';
import { EventQueue, type OutboxMessage } from '../../src/sync/event-queue';
import { OutboxRelay } from '../../src/sync/outbox-relay';
import { SyncScheduler } from '../../src/sync/sync-scheduler';
import type { SyncQueue } from '../../src/sync/sync-queue';
import { SystemSweeper } from '../../src/sync/system-sweeper';
import {
  TaskQueue,
  type TenantTask,
  eventQueueName,
  taskQueueName,
} from '../../src/sync/task-queue';
import { TaskWorker } from '../../src/sync/task.worker';
import { createFixture, env, type Fixture } from './harness';

// E5.4 and E5.5 (ADR-0017): the outbox relay, the scheduler and the sweeper. The sweeper may list
// tenants as bp_system; everything that touches tenant data runs per tenant under RLS.

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(async () => {
  await f.close();
});

const addEvent = (tenantId: string, ref: string, publishedAt?: Date) =>
  f.db.tenantTx(
    tenantId,
    async (tx) =>
      (
        await tx
          .insertInto('core.outbox_event')
          .values({
            tenant_id: tenantId,
            type: 'dataset.version_changed',
            aggregate_ref: ref,
            payload: JSON.stringify({ data_version: 1 }),
            ...(publishedAt ? { published_at: publishedAt } : {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );
const state = (tenantId: string, id: string) =>
  f.db.tenantTx(tenantId, (tx) =>
    tx
      .selectFrom('core.outbox_event')
      .select('published_at')
      .where('id', '=', id)
      .executeTakeFirst(),
  );

function recorder(): { queue: EventQueue; sent: OutboxMessage[] } {
  const sent: OutboxMessage[] = [];
  return {
    sent,
    queue: {
      publish: (m: OutboxMessage) => (sent.push(m), Promise.resolve()),
    } as unknown as EventQueue,
  };
}

describe('the bp_system login', () => {
  it('lists active tenants and can read nothing else', async () => {
    const system = new SystemDatabase(env());
    expect(system.enabled).toBe(true);
    const ids = await system.activeTenantIds();
    expect(ids).toEqual(expect.arrayContaining([f.A.tenantId, f.B.tenantId]));
    await system.onModuleDestroy();

    const e = env();
    const client = new Client({
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      database: e.POSTGRES_DB,
      user: 'bp_system',
      password: e.POSTGRES_SYSTEM_PASSWORD,
    });
    await client.connect();
    try {
      for (const t of [
        'core.outbox_event',
        'core.sync_run',
        'core.notification',
        'analytics.invoice',
      ])
        await expect(client.query(`SELECT 1 FROM ${t}`)).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

describe('outbox relay', () => {
  it('publishes only the tenant it runs for, once, and marks the events published', async () => {
    const a = await addEvent(f.A.tenantId, 'relay-a');
    const b = await addEvent(f.B.tenantId, 'relay-b');
    const { queue, sent } = recorder();
    const relay = new OutboxRelay(f.db, queue, new Set(['dataset.version_changed']));
    expect(await relay.relayTenant(f.A.tenantId)).toBeGreaterThanOrEqual(1);
    expect(sent.map((m) => m.eventId)).toContain(a);
    expect(sent.every((m) => m.tenantId === f.A.tenantId)).toBe(true);
    expect((await state(f.A.tenantId, a))?.published_at).not.toBeNull();
    expect((await state(f.B.tenantId, b))?.published_at).toBeNull(); // another tenant's event is untouched
    sent.length = 0;
    await relay.relayTenant(f.A.tenantId);
    expect(sent).toEqual([]);
  });

  it('marks events with no subscriber published without queueing them', async () => {
    const id = await addEvent(f.A.tenantId, 'no-subscriber');
    const { queue, sent } = recorder();
    await new OutboxRelay(f.db, queue, new Set()).relayTenant(f.A.tenantId);
    expect(sent).toEqual([]);
    expect((await state(f.A.tenantId, id))?.published_at).not.toBeNull();
  });

  it('keeps an event unpublished when the queue fails, so it is retried', async () => {
    const id = await addEvent(f.A.tenantId, 'queue-down');
    const down = { publish: () => Promise.reject(new Error('down')) } as unknown as EventQueue;
    await expect(
      new OutboxRelay(f.db, down, new Set(['dataset.version_changed'])).relayTenant(f.A.tenantId),
    ).rejects.toThrow();
    expect((await state(f.A.tenantId, id))?.published_at).toBeNull();
  });

  it('deletes old published events but can never delete an unpublished one', async () => {
    const old = await addEvent(f.A.tenantId, 'old', new Date(Date.now() - 8 * 86_400_000));
    const pending = await addEvent(f.A.tenantId, 'pending');
    const lock = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx.deleteFrom('core.outbox_event').where('id', '=', pending).executeTakeFirst(),
    );
    expect(Number(lock.numDeletedRows)).toBe(0);
    const { queue } = recorder();
    await new OutboxRelay(f.db, queue, new Set()).relayTenant(f.A.tenantId);
    expect(await state(f.A.tenantId, old)).toBeUndefined();
    expect(await state(f.A.tenantId, pending)).toBeDefined();
  });
});

describe('sync scheduler', () => {
  const mk = async (type: string, status = 'connected', mapping = true) =>
    f.db.tenantTx(f.A.tenantId, async (tx) => {
      const ds = await tx
        .insertInto('core.data_source')
        .values({
          tenant_id: f.A.tenantId,
          name: `sched ${randomUUID().slice(0, 6)}`,
          type,
          access_mode: 'managed_sync',
          connection: '{}',
          credential_id: null,
          status: status as 'connected',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (mapping)
        await tx
          .insertInto('core.entity_mapping')
          .values({
            tenant_id: f.A.tenantId,
            data_source_id: ds.id,
            source_object: 't',
            canonical_entity: 'customer',
            status: 'active',
            document: '{}',
            confidence: null,
            created_by: null,
            approved_by: f.A.ownerUserId,
            approved_at: new Date(),
            activated_by: f.A.ownerUserId,
            activated_at: new Date(),
          })
          .execute();
      return ds.id;
    });
  const run = (id: string, status: 'running' | 'succeeded', minutesAgo: number) =>
    f.db.tenantTx(f.A.tenantId, (tx) =>
      sql`INSERT INTO core.sync_run (tenant_id, data_source_id, status, trigger, started_at)
          VALUES (${f.A.tenantId}, ${id}, ${status}, 'schedule', now() - ${`${minutesAgo} minutes`}::interval)`.execute(
        tx,
      ),
    );
  const sched = (queued: unknown[] = []) =>
    new SyncScheduler(f.db, {
      enqueue: (j: unknown) => (queued.push(j), Promise.resolve({ jobId: 'x' })),
    } as unknown as SyncQueue);

  it('picks a database source that has never synced or is overdue, and skips the rest', async () => {
    const fresh = await mk('postgresql');
    const never = await mk('postgresql');
    const overdue = await mk('postgresql');
    const recent = await mk('postgresql');
    const running = await mk('postgresql');
    const failing = await mk('postgresql', 'error');
    const unmapped = await mk('postgresql', 'connected', false);
    const excel = await mk('excel');
    await run(fresh, 'succeeded', 1);
    await run(overdue, 'succeeded', 20);
    await run(recent, 'succeeded', 5);
    await run(running, 'running', 30);
    const due = await sched().dueSources(f.A.tenantId);
    expect(due).toEqual(expect.arrayContaining([never, overdue]));
    for (const id of [fresh, recent, running, failing, unmapped, excel])
      expect(due).not.toContain(id);
  });

  it('queues a schedule-triggered sync for each due source, in this tenant only', async () => {
    const queued: { tenantId: string; trigger: string }[] = [];
    const id = await mk('postgresql');
    const n = await sched(queued).scheduleTenant(f.A.tenantId);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(queued.every((j) => j.tenantId === f.A.tenantId && j.trigger === 'schedule')).toBe(true);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ dataSourceId: id })]));
    expect(await sched().dueSources(f.B.tenantId)).toEqual([]);
  });
});

describe('sweeper', () => {
  it('queues a relay and a schedule task for every active tenant', async () => {
    const tasks: TenantTask[] = [];
    const system = new SystemDatabase(env());
    const sweeper = new SystemSweeper(system, {
      enqueue: (t: TenantTask) => (tasks.push(t), Promise.resolve()),
    } as unknown as TaskQueue);
    expect(await sweeper.sweep()).toBeGreaterThanOrEqual(2);
    for (const tenantId of [f.A.tenantId, f.B.tenantId])
      for (const kind of ['relay', 'schedule'] as const)
        expect(tasks).toContainEqual({ kind, tenantId });
    await system.onModuleDestroy();
  });
});

describe.skipIf(!process.env.REDIS_URL)('task and event queues (real Redis)', () => {
  const name = `test_sys_${process.pid}`;
  const e = () => loadEnv({ ...process.env, SYNC_QUEUE_NAME: name });

  it('runs a queued relay task for its tenant, and an event id is queued once', async () => {
    const calls: string[] = [];
    const worker = new TaskWorker(
      e(),
      { relayTenant: (t: string) => (calls.push(t), Promise.resolve(0)) } as unknown as OutboxRelay,
      { scheduleTenant: () => Promise.resolve(0) } as unknown as SyncScheduler,
    );
    worker.onModuleInit();
    const tasks = new TaskQueue(e());
    const events = new EventQueue(e());
    try {
      await tasks.enqueue({ kind: 'relay', tenantId: f.A.tenantId });
      await tasks.enqueue({ kind: 'relay', tenantId: f.A.tenantId }); // same minute: collapses
      await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
      await new Promise((r) => setTimeout(r, 400));
      expect(calls).toEqual([f.A.tenantId]);

      const msg = {
        eventId: randomUUID(),
        tenantId: f.A.tenantId,
        type: 't',
        aggregateRef: 'r',
        payload: {},
      };
      await events.publish(msg);
      await events.publish(msg);
      const q = new Queue(eventQueueName(e()), {
        connection: {
          host: new URL(process.env.REDIS_URL as string).hostname,
          port: Number(new URL(process.env.REDIS_URL as string).port || 6379),
          password: process.env.REDIS_PASSWORD,
        },
      });
      expect(await q.getJobCounts('waiting', 'delayed', 'active', 'completed')).toMatchObject({
        waiting: 1,
      });
      await q.obliterate({ force: true });
      await q.close();
    } finally {
      await worker.onModuleDestroy();
      await tasks.onModuleDestroy();
      await events.onModuleDestroy();
      const t = new Queue(taskQueueName(e()), {
        connection: {
          host: new URL(process.env.REDIS_URL as string).hostname,
          port: Number(new URL(process.env.REDIS_URL as string).port || 6379),
          password: process.env.REDIS_PASSWORD,
        },
      });
      await t.obliterate({ force: true });
      await t.close();
    }
  });
});
