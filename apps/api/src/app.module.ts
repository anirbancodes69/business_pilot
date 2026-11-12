import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AiEngineModule } from './platform/ai-engine/ai-engine.module';
import { ConfigModule } from './platform/config/config.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { CryptoModule } from './platform/crypto/crypto.module';
import { DatabaseModule } from './platform/database/database.module';
import { requestIdMiddleware } from './platform/request-id/request-id';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AiEngineModule,
    HealthModule,
    TenancyModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware).forRoutes('*path');
  }
}
