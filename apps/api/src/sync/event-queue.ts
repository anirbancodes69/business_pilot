import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { redisConnection } from './sync-queue';
import { eventQueueName } from './task-queue';

export interface OutboxMessage {
  eventId: string;
  tenantId: string;
  type: string;
  aggregateRef: string;
  /** Identifiers and versions only (ADR-0005). */
  payload: unknown;
}

/** Publishes outbox events. The event id is the job id, so adding the same event twice is a no-op. */
@Injectable()
export class EventQueue implements OnModuleDestroy {
  private queue: Queue<OutboxMessage> | undefined;

  constructor(@Inject(Env_TOKEN) private readonly env: Env) {}

  async publish(message: OutboxMessage): Promise<void> {
    const connection = redisConnection(this.env);
    if (!connection) throw new ServiceUnavailableException('the job queue is not configured');
    this.queue ??= new Queue<OutboxMessage>(eventQueueName(this.env), { connection });
    await this.queue.add(message.type, message, {
      jobId: message.eventId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
