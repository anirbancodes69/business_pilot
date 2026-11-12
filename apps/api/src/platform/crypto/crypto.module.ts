import { Global, Module } from '@nestjs/common';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { EnvelopeCrypto } from './envelope';
import { LocalKeyManagement } from './key-management';

/** Null when no KEK is configured: operations that need encryption then fail closed. */
export const ENVELOPE_TOKEN = Symbol('ENVELOPE');

@Global()
@Module({
  providers: [
    {
      provide: ENVELOPE_TOKEN,
      inject: [Env_TOKEN],
      useFactory: (env: Env): EnvelopeCrypto | null =>
        env.LOCAL_KEK_BASE64
          ? new EnvelopeCrypto(new LocalKeyManagement(env.LOCAL_KEK_BASE64))
          : null,
    },
  ],
  exports: [ENVELOPE_TOKEN],
})
export class CryptoModule {}
