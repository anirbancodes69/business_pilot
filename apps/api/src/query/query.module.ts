import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { RequestContextSigner } from '../platform/service-auth/request-context';
import { ServiceTokenGuard } from '../platform/service-auth/service-token.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { InternalToolsController } from './internal-tools.controller';
import { PlanExecutor } from './plan-executor';

@Module({
  imports: [TenancyModule],
  controllers: [InternalToolsController],
  providers: [
    PlanExecutor,
    ServiceTokenGuard,
    {
      provide: RequestContextSigner,
      inject: [Env_TOKEN],
      useFactory: (env: Env) =>
        // Without a configured key a random one is used: nobody can sign for it, so every call is refused.
        new RequestContextSigner([
          env.REQUEST_CONTEXT_SIGNING_KEY ?? randomBytes(32).toString('hex'),
        ]),
    },
  ],
  exports: [PlanExecutor, RequestContextSigner],
})
export class QueryModule {}
