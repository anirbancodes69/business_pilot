import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { createDb, pingDb, type Database } from './database';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly db: Kysely<Database>;

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.db = createDb(env, 'app');
  }

  ping(): Promise<void> {
    return pingDb(this.db);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
