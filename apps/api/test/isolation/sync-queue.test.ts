import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/platform/config/env';
import { SyncQueue } from '../../src/sync/sync-queue';
import type { SyncService } from '../../src/sync/sync.service';
import { SyncAlreadyRunningError } from '../../src/sync/sync.service';
import { SyncWorker } from '../../src/sync/sync.worker';

// E5.1: a queued job reaches the consumer with identifiers only, a retryable error is retried, and
// a permanent one is not. Needs Redis (REDIS_URL): skipped without it. Uses its own queue name.

const redis = Boolean(process.env.REDIS_URL);
const env = () => ({
  ...loadEnv({ ...process.env, SYNC_QUEUE_NAME: `test_${process.pid}` }),
});

describe.skipIf(!redis)('sync queue and worker', () => {
  const seen: unknown[][] = [];
  let attempts = 0;
  let queue: SyncQueue;
  let worker: SyncWorker;
  const ids = { tenantId: crypto.randomUUID(), dataSourceId: crypto.randomUUID() };

  beforeAll(() => {
    queue = new SyncQueue(env());
    const service = {
      run: (...args: unknown[]) => {
        seen.push(args);
        attempts++;
        if (args[2] === 'upload') return Promise.reject(new SyncAlreadyRunningError());
        return Promise.resolve({ runId: 'r', status: 'succeeded', objects: {} });
      },
    } as unknown as SyncService;
    worker = new SyncWorker(env(), service);
    worker.onModuleInit();
  });
  afterAll(async () => {
    await worker.onModuleDestroy();
    await queue.onModuleDestroy();
  });

  it('delivers the identifiers to the consumer and dedupes a double request', async () => {
    const a = await queue.enqueue({ ...ids, trigger: 'manual' });
    const b = await queue.enqueue({ ...ids, trigger: 'manual' });
    expect(b.jobId).toBe(a.jobId);
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual([ids.tenantId, ids.dataSourceId, 'manual']);
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toHaveLength(1);
  });

  it('does not retry a permanent failure', async () => {
    attempts = 0;
    await queue.enqueue({ ...ids, trigger: 'upload' });
    await expect.poll(() => attempts, { timeout: 10_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 1500)); // a retry would wait 30 s: none may start
    expect(attempts).toBe(1);
  });

  it('rejects a payload with extra fields', async () => {
    await expect(
      queue.enqueue({ ...ids, trigger: 'manual', password: 'x' } as never),
    ).rejects.toThrow();
  });
});
