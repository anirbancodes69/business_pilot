import { randomUUID } from 'node:crypto';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../configuration/templates/wholesale-distribution';
import { type Tx, sql } from '../platform/database/database.module';
import {
  type SyntheticData,
  type SyntheticRow,
  syntheticDistributor,
} from './synthetic-distributor';

const TABLES = [
  'branch',
  'customer',
  'product',
  'invoice',
  'invoice_line',
  'payment',
  'payment_allocation',
] as const;

/**
 * Loads the synthetic distributor into one tenant's analytics tables and, when missing, publishes
 * the wholesale semantic model and activates the default access policy. Runs inside the caller's
 * tenant transaction (so RLS applies). Used by the dev seed command and by the golden-set tests.
 * It writes canonical tables directly: it does not exercise connectors, mapping or sync.
 */
export async function seedSynthetic(
  tx: Tx,
  tenantId: string,
  data: SyntheticData = syntheticDistributor(),
): Promise<Record<string, number>> {
  const existing = await sql<{
    n: string;
  }>`select count(*)::text as n from analytics.branch`.execute(tx);
  if (Number(existing.rows[0]?.n) > 0) throw new Error('this tenant already has analytics data');
  const dataSourceId = randomUUID();
  for (const table of TABLES) {
    const rows: SyntheticRow[] = data[table];
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const cols = Object.keys(batch[0] as SyntheticRow);
      await sql`insert into ${sql.table(`analytics.${table}`)}
        (tenant_id, data_source_id, source_key, ${sql.join(cols.map((c) => sql.ref(c)))})
        values ${sql.join(
          batch.map(
            (row) =>
              sql`(${tenantId}, ${dataSourceId}, ${`seed-${String(row.id)}`}, ${sql.join(cols.map((c) => row[c] ?? null))})`,
          ),
        )}`.execute(tx);
    }
  }
  const model = await tx
    .selectFrom('core.semantic_model')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'published')
    .executeTakeFirst();
  if (!model)
    await tx
      .insertInto('core.semantic_model')
      .values({
        tenant_id: tenantId,
        version: 1,
        status: 'published',
        document: JSON.stringify(wholesaleDistributionTemplate()),
      })
      .execute();
  const policy = await tx
    .selectFrom('core.access_policy')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!policy)
    await tx
      .insertInto('core.access_policy')
      .values({
        tenant_id: tenantId,
        version: 1,
        status: 'active',
        document: JSON.stringify(wholesaleDistributionPolicy()),
      })
      .execute();
  return Object.fromEntries(TABLES.map((t) => [t, data[t].length]));
}
