import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MappingController } from './mapping.controller';

@Module({
  imports: [TenancyModule, ConnectorsModule],
  controllers: [MappingController],
})
export class MappingModule {}
