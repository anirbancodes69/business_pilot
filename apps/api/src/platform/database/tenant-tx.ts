import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from './schema';

export type Tx = Transaction<Database>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new Error(`${what} must be a UUID`);
  return value;
}

export interface TxOptions {
  readOnly?: boolean;
  statementTimeoutMs?: number;
}

/**
 * Runs `fn` in a transaction with tenant context set transaction-locally.
 * set_config(..., is_local => true) is the parameterizable form of SET LOCAL: the value disappears
 * when the transaction ends, so it cannot leak to the next user of a pooled connection.
 * The tenant id must come from an authenticated session and membership, never from client input.
 */
export function withTenantTx<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  assertUuid(tenantId, 'tenantId');
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
    await applyOptions(tx, options);
    return fn(tx);
  });
}

/**
 * Context for the single defined login exception (P-15 exception 1): only `app.user_id` is set,
 * so a user can list their own memberships and nothing else.
 */
export function withUserTx<T>(
  db: Kysely<Database>,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'userId');
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** No tenant or user context. Only for global identity tables (app_user, permission). */
export function withIdentityTx<T>(db: Kysely<Database>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

async function applyOptions(tx: Tx, options: TxOptions): Promise<void> {
  if (options.readOnly) await sql`set transaction read only`.execute(tx);
  if (options.statementTimeoutMs !== undefined) {
    const ms = Math.trunc(options.statementTimeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('invalid statement timeout');
    await sql`select set_config('statement_timeout', ${String(ms)}, true)`.execute(tx);
  }
}
