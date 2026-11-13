import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AccessPolicyController } from './access-policy.controller';
import { SemanticViewController } from './semantic-view.controller';
import { SemanticModelController } from './semantic-model.controller';

@Module({
  imports: [TenancyModule],
  controllers: [SemanticModelController, AccessPolicyController, SemanticViewController],
})
export class ConfigurationModule {}
