import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../configuration/templates/wholesale-distribution';
import { loadEnv } from '../platform/config/env';
import { DatabaseService, sql } from '../platform/database/database.module';
import { syntheticDistributor, type SyntheticRow } from './synthetic-distributor';

// Development command: loads the synthetic distributor into ONE tenant's analytics tables, publishes
// the wholesale semantic model and activates the default access policy (what the API's
// from-template and publish routes do), so the question flow can be tried end to end.
// It writes canonical tables directly. It does NOT exercise the connectors, mapping or sync.
// It runs as the application role under the tenant's own context. Safe to run twice: it stops if
// the tenant already has seed data.
//
//   node dist/dev/seed-demo.js --tenant-id <uuid>

const TABLES = [
  'branch',
  'customer',
  'product',
  'invoice',
  'invoice_line',
  'payment',
  'payment_allocation',
] as const;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'tenant-id': { type: 'string' } } });
  const tenantId = z.string().uuid().parse(values['tenant-id']);
  const db = new DatabaseService(loadEnv());
  try {
    const dataSourceId = randomUUID();
    const data = syntheticDistributor();
    const counts = await db.tenantTx(tenantId, async (tx) => {
      const existing = await sql<{
        n: string;
      }>`select count(*)::text as n from analytics.branch`.execute(tx);
      if (Number(existing.rows[0]?.n) > 0)
        throw new Error('this tenant already has analytics data');
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
    });
    console.log(`seeded tenant ${tenantId}:`, JSON.stringify(counts));
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'seed failed');
  process.exit(1);
});
