import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SyncController } from './sync.controller';
import { SyncQueue } from './sync-queue';
import { SyncService } from './sync.service';

/** The consumer (SyncWorker) is registered by the worker module only, never by the api. */
@Module({
  imports: [ConnectorsModule, TenancyModule],
  controllers: [SyncController],
  providers: [SyncQueue, SyncService],
  exports: [SyncService, SyncQueue],
})
export class SyncModule {}
