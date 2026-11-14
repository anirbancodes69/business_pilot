import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { createDb, type Database } from './database';

/**
 * The `bp_system` connection (P-15 b, ADR-0017). It can list tenant ids and status and nothing
 * else: the database grants it no other table. It exists so the worker can find out which tenants
 * have work, and every task that touches tenant data runs as a per-tenant job under RLS.
 */
@Injectable()
export class SystemDatabase implements OnModuleDestroy {
  private db: Kysely<Database> | undefined;

  constructor(@Inject(Env_TOKEN) private readonly env: Env) {}

  get enabled(): boolean {
    return this.env.POSTGRES_SYSTEM_PASSWORD !== undefined;
  }

  async activeTenantIds(): Promise<string[]> {
    this.db ??= createDb(this.env, 'system');
    const r = await sql<{
      id: string;
    }>`SELECT id FROM core.tenant WHERE status = 'active' ORDER BY id`.execute(this.db);
    return r.rows.map((x) => x.id);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db?.destroy();
  }
}
