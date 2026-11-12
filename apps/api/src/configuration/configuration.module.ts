import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SemanticModelController } from './semantic-model.controller';

@Module({ imports: [TenancyModule], controllers: [SemanticModelController] })
export class ConfigurationModule {}
