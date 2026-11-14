import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SystemDatabase } from '../platform/database/database.module';
import { TaskQueue } from './task-queue';

export const SWEEP_EVERY_MS = 60_000;

/**
 * Once a minute: list the active tenants as `bp_system` and queue a relay task and a schedule task
 * for each (ADR-0017). It reads no tenant data. Several workers may sweep at once: the task job ids
 * collapse the repeats.
 */
@Injectable()
export class SystemSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SystemSweeper');
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    @Inject(SystemDatabase) private readonly system: SystemDatabase,
    @Inject(TaskQueue) private readonly tasks: TaskQueue,
  ) {}

  onModuleInit(): void {
    if (!this.system.enabled) {
      this.log.warn('POSTGRES_SYSTEM_PASSWORD is not set: no scheduled syncs, no relay sweep');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
    void this.sweep();
  }

  async sweep(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const tenants = await this.system.activeTenantIds();
      for (const tenantId of tenants) {
        await this.tasks.enqueue({ kind: 'relay', tenantId });
        await this.tasks.enqueue({ kind: 'schedule', tenantId });
      }
      return tenants.length;
    } catch {
      this.log.warn('sweep failed'); // the next one retries
      return 0;
    } finally {
      this.busy = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
