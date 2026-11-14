import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';

// Sync jobs (E5.1). The payload holds identifiers only: no credentials, no data. Authorization
// happens in the API before a job is queued. The worker still loads everything for that tenant
// under row-level security.

export const syncJobSchema = z.strictObject({
  tenantId: z.string().uuid(),
  dataSourceId: z.string().uuid(),
  trigger: z.enum(['manual', 'schedule', 'upload', 'activation']),
});
export type SyncJob = z.infer<typeof syncJobSchema>;

export function redisConnection(env: Env): ConnectionOptions | undefined {
  if (!env.REDIS_URL) return undefined;
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    // Fail commands fast while disconnected instead of queueing them forever.
    enableOfflineQueue: false,
  };
}

export const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

@Injectable()
export class SyncQueue implements OnModuleDestroy {
  private queue: Queue<SyncJob> | undefined;

  constructor(@Inject(Env_TOKEN) private readonly env: Env) {}

  private get(): Queue<SyncJob> {
    const connection = redisConnection(this.env);
    if (!connection) throw new ServiceUnavailableException('the job queue is not configured');
    this.queue ??= new Queue<SyncJob>(this.env.SYNC_QUEUE_NAME, { connection });
    return this.queue;
  }

  /** Requests made within the same minute for the same source share one job. */
  async enqueue(job: SyncJob): Promise<{ jobId: string }> {
    const minute = Math.floor(Date.now() / 60_000);
    // Scheduled and upload syncs are deduplicated per minute. Manual ones too, to absorb double clicks.
    const jobId = `sync_${job.dataSourceId}_${job.trigger}_${minute}`;
    try {
      await this.get().add('sync', syncJobSchema.parse(job), { ...JOB_OPTIONS, jobId });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('the job queue is unavailable');
    }
    return { jobId };
  }

  async ping(): Promise<void> {
    await this.get().getJobCounts();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
