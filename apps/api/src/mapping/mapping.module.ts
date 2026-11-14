import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SyncQueueModule } from '../sync/sync-queue.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MappingController } from './mapping.controller';

@Module({
  imports: [TenancyModule, ConnectorsModule, SyncQueueModule],
  controllers: [MappingController],
})
export class MappingModule {}
