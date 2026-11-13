import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConnectorRegistry } from './connector-registry';
import { DataSourceController } from './data-source.controller';

@Module({
  imports: [TenancyModule],
  controllers: [DataSourceController],
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
