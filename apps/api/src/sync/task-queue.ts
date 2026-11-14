import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { redisConnection } from './sync-queue';

// Per-tenant system tasks (ADR-0017). The sweeper finds tenants as `bp_system` and queues one task
// per tenant and kind. The task itself runs as `bp_app` with that tenant's context. A payload holds
// the kind and the tenant id only.

export const taskSchema = z.strictObject({
  kind: z.enum(['relay', 'schedule']),
  tenantId: z.string().uuid(),
});
export type TenantTask = z.infer<typeof taskSchema>;

export const taskQueueName = (env: Env): string => `${env.SYNC_QUEUE_NAME}_tasks`;
export const eventQueueName = (env: Env): string => `${env.SYNC_QUEUE_NAME}_events`;

@Injectable()
export class TaskQueue implements OnModuleDestroy {
  private readonly log = new Logger('TaskQueue');
  private queue: Queue<TenantTask> | undefined;

  constructor(@Inject(Env_TOKEN) private readonly env: Env) {}

  /** Repeats within the same minute collapse into one job. */
  async enqueue(task: TenantTask): Promise<void> {
    const connection = redisConnection(this.env);
    if (!connection) throw new ServiceUnavailableException('the job queue is not configured');
    this.queue ??= new Queue<TenantTask>(taskQueueName(this.env), { connection });
    const minute = Math.floor(Date.now() / 60_000);
    await this.queue.add(task.kind, taskSchema.parse(task), {
      jobId: `${task.kind}_${task.tenantId}_${minute}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000, jitter: 0.5 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    });
  }

  /** The fast path: a failure here is covered by the sweeper a minute later. */
  async enqueueQuietly(task: TenantTask): Promise<void> {
    try {
      await this.enqueue(task);
    } catch {
      this.log.warn(`could not queue a ${task.kind} task`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
