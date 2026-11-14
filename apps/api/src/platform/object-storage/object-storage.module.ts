import { Global, Module } from '@nestjs/common';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { DummyObjectStorage } from './dummy-object-storage';
import { LocalObjectStorage } from './local-object-storage';
import { OBJECT_STORAGE_TOKEN, type ObjectStorage } from './object-storage';

/** The only place that picks an adapter: `dummy` (in memory, ADR-0015) or `local` (a directory, ADR-0016). */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_TOKEN,
      inject: [Env_TOKEN],
      useFactory: (env: Env): ObjectStorage => {
        if (env.OBJECT_STORAGE_DRIVER === 'dummy') return new DummyObjectStorage();
        if (env.OBJECT_STORAGE_DRIVER === 'local') {
          if (!env.OBJECT_STORAGE_LOCAL_DIR) throw new Error('OBJECT_STORAGE_LOCAL_DIR is not set');
          return new LocalObjectStorage(env.OBJECT_STORAGE_LOCAL_DIR);
        }
        throw new Error('unsupported object storage driver');
      },
    },
  ],
  exports: [OBJECT_STORAGE_TOKEN],
})
export class ObjectStorageModule {}
