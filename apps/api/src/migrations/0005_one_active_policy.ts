import { type Kysely, sql } from 'kysely';

// At most one active access policy per tenant, so the evaluated policy is never ambiguous.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `CREATE UNIQUE INDEX access_policy_one_active ON core.access_policy (tenant_id) WHERE status = 'active'`,
    )
    .execute(db);
}
