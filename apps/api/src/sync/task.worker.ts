import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { UnrecoverableError, Worker } from 'bullmq';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { OutboxRelay } from './outbox-relay';
import { SyncScheduler } from './sync-scheduler';
import { redisConnection } from './sync-queue';
import { taskQueueName, taskSchema } from './task-queue';

/** Consumes per-tenant system tasks as `bp_app` (ADR-0017). Worker process only. */
@Injectable()
export class TaskWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TaskWorker');
  private worker: Worker | undefined;

  constructor(
    @Inject(Env_TOKEN) private readonly env: Env,
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(SyncScheduler) private readonly scheduler: SyncScheduler,
  ) {}

  onModuleInit(): void {
    const connection = redisConnection(this.env);
    if (!connection) return;
    this.worker = new Worker(
      taskQueueName(this.env),
      async (job) => {
        const task = taskSchema.safeParse(job.data);
        if (!task.success) throw new UnrecoverableError('invalid task payload');
        if (task.data.kind === 'relay')
          return { published: await this.relay.relayTenant(task.data.tenantId) };
        return { scheduled: await this.scheduler.scheduleTenant(task.data.tenantId) };
      },
      {
        connection: { ...connection, enableOfflineQueue: true, maxRetriesPerRequest: null },
        concurrency: 4,
      },
    );
    this.worker.on('error', (e) =>
      this.log.warn(`queue connection error: ${(e as NodeJS.ErrnoException).code ?? e.name}`),
    );
    this.worker.on('failed', (job, e) =>
      this.log.warn(`task ${job?.name ?? '?'} failed: ${e.name}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
