import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { createDb, pingDb, type Database } from './database';
import { type Tx, type TxOptions, withIdentityTx, withTenantTx, withUserTx } from './tenant-tx';

export type { Tx };

/** The only holder of the application database handle. Other modules receive a `Tx`. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly db: Kysely<Database>;

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.db = createDb(env, 'app');
  }

  ping(): Promise<void> {
    return pingDb(this.db);
  }

  tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return withTenantTx(this.db, tenantId, fn, options);
  }

  userTx<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUserTx(this.db, userId, fn);
  }

  identityTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withIdentityTx(this.db, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
