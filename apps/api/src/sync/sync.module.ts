import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { NotificationsController } from './notifications.controller';
import { SyncController } from './sync.controller';
import { SyncQueueModule } from './sync-queue.module';
import { EVENT_SUBSCRIBERS, OutboxRelay } from './outbox-relay';
import { SyncScheduler } from './sync-scheduler';
import { SyncService } from './sync.service';

/** The consumer (SyncWorker) is registered by the worker module only, never by the api. */
@Module({
  imports: [ConnectorsModule, TenancyModule, SyncQueueModule],
  controllers: [SyncController, NotificationsController],
  providers: [
    SyncService,
    OutboxRelay,
    SyncScheduler,
    { provide: EVENT_SUBSCRIBERS, useValue: new Set<string>() },
  ],
  exports: [SyncService, OutboxRelay, SyncScheduler],
})
export class SyncModule {}
