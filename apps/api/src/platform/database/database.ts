import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';
import type { Env } from '../config/env';
import type { Database } from './schema';

export type { Database };

export type Role = 'app' | 'owner' | 'system';

// A `date` column is a calendar day, not an instant. The driver's default turns it into a JavaScript
// Date at local midnight, which serialises as a timestamp and can land on the wrong day when the
// server's time zone is not UTC. Return the text the database gives: 'YYYY-MM-DD'.
const dateAsText = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === types.builtins.DATE
      ? (value: string) => value
      : types.getTypeParser(oid as never, format as never),
};

export function createDb(env: Env, role: Role): Kysely<Database> {
  const owner = role === 'owner';
  const password =
    role === 'owner'
      ? env.POSTGRES_OWNER_PASSWORD
      : role === 'system'
        ? env.POSTGRES_SYSTEM_PASSWORD
        : env.POSTGRES_APP_PASSWORD;
  if (!password) throw new Error('Database password is not configured');
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        database: env.POSTGRES_DB,
        user: owner
          ? env.POSTGRES_OWNER_USER
          : role === 'system'
            ? 'bp_system'
            : env.POSTGRES_APP_USER,
        password,
        max: role === 'system' ? 2 : 10,
        connectionTimeoutMillis: 3000,
        types: dateAsText as never,
      }),
    }),
  });
}

export async function pingDb(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
