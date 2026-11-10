import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env';

export const Env_TOKEN = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: Env_TOKEN, useFactory: () => loadEnv() }],
  exports: [Env_TOKEN],
})
export class ConfigModule {}
