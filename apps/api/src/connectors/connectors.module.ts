import { Module } from '@nestjs/common';
import { SyncQueueModule } from '../sync/sync-queue.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConnectorRegistry } from './connector-registry';
import { DataSourceService } from './data-source.service';
import { DataSourceController } from './data-source.controller';

@Module({
  imports: [TenancyModule, SyncQueueModule],
  controllers: [DataSourceController],
  providers: [ConnectorRegistry, DataSourceService],
  exports: [ConnectorRegistry, DataSourceService],
})
export class ConnectorsModule {}
