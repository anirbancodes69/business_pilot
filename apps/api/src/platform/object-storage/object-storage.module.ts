import { Global, Module } from '@nestjs/common';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { DummyObjectStorage } from './dummy-object-storage';
import { OBJECT_STORAGE_TOKEN, type ObjectStorage } from './object-storage';

/** The only place that picks an adapter. `dummy` is the only one that exists (ADR-0015). */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_TOKEN,
      inject: [Env_TOKEN],
      useFactory: (env: Env): ObjectStorage => {
        if (env.OBJECT_STORAGE_DRIVER === 'dummy') return new DummyObjectStorage();
        throw new Error('unsupported object storage driver');
      },
    },
  ],
  exports: [OBJECT_STORAGE_TOKEN],
})
export class ObjectStorageModule {}
