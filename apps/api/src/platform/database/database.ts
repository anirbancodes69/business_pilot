import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { Env } from '../config/env';

/**
 * Table types. Empty in Milestone 1: tenant tables, roles, RLS and `withTenantTx`
 * arrive in Milestone 2. Only `platform` may import Kysely or the pool (ADR-0009, ESLint rule).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no tables until M2
export interface Database {}

export type Role = 'app' | 'owner';

export function createDb(env: Env, role: Role): Kysely<Database> {
  const owner = role === 'owner';
  const password = owner ? env.POSTGRES_OWNER_PASSWORD : env.POSTGRES_APP_PASSWORD;
  if (!password) throw new Error('Database password is not configured');
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        database: env.POSTGRES_DB,
        user: owner ? env.POSTGRES_OWNER_USER : env.POSTGRES_APP_USER,
        password,
        max: 10,
        connectionTimeoutMillis: 3000,
      }),
    }),
  });
}

export async function pingDb(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
