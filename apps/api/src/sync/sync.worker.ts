import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { UnrecoverableError, Worker } from 'bullmq';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { redisConnection, syncJobSchema } from './sync-queue';
import {
  NoActiveMappingError,
  SyncAlreadyRunningError,
  SyncNotPossibleError,
  SyncService,
} from './sync.service';

/** The sync consumer. It runs only in the worker process. Logs carry ids and codes, never data. */
@Injectable()
export class SyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SyncWorker');
  private worker: Worker | undefined;

  constructor(
    @Inject(Env_TOKEN) private readonly env: Env,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

  onModuleInit(): void {
    const connection = redisConnection(this.env);
    if (!connection) {
      this.log.warn('REDIS_URL is not set: sync jobs are not consumed');
      return;
    }
    this.worker = new Worker(
      this.env.SYNC_QUEUE_NAME,
      async (job) => {
        const data = syncJobSchema.safeParse(job.data);
        if (!data.success) throw new UnrecoverableError('invalid job payload');
        try {
          const result = await this.sync.run(
            data.data.tenantId,
            data.data.dataSourceId,
            data.data.trigger,
          );
          return { run_id: result.runId, status: result.status };
        } catch (error) {
          if (error instanceof NoActiveMappingError) return { skipped: 'no_active_mapping' };
          // Nothing a retry can fix: do not retry. Anything else (transient) is retried with backoff.
          if (error instanceof SyncAlreadyRunningError || error instanceof SyncNotPossibleError)
            throw new UnrecoverableError(error.message);
          throw error;
        }
      },
      {
        connection: { ...connection, enableOfflineQueue: true, maxRetriesPerRequest: null },
        concurrency: 2,
      },
    );
    this.worker.on('error', (error) =>
      this.log.warn(
        `queue connection error: ${(error as NodeJS.ErrnoException).code ?? error.name}`,
      ),
    );
    this.worker.on('failed', (job, error) =>
      this.log.warn(`sync job ${job?.id ?? '?'} failed: ${error.name}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
