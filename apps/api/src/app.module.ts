import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConnectorsModule } from './connectors/connectors.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { MappingModule } from './mapping/mapping.module';
import { HealthModule } from './health/health.module';
import { AiEngineModule } from './platform/ai-engine/ai-engine.module';
import { ConfigModule } from './platform/config/config.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { CryptoModule } from './platform/crypto/crypto.module';
import { DatabaseModule } from './platform/database/database.module';
import { ObjectStorageModule } from './platform/object-storage/object-storage.module';
import { requestIdMiddleware } from './platform/request-id/request-id';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    ObjectStorageModule,
    AiEngineModule,
    HealthModule,
    TenancyModule,
    ConfigurationModule,
    ConnectorsModule,
    MappingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware).forRoutes('*path');
  }
}
