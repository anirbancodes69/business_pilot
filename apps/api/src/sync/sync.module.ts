import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SyncController } from './sync.controller';
import { SyncQueueModule } from './sync-queue.module';
import { SyncService } from './sync.service';

/** The consumer (SyncWorker) is registered by the worker module only, never by the api. */
@Module({
  imports: [ConnectorsModule, TenancyModule, SyncQueueModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
