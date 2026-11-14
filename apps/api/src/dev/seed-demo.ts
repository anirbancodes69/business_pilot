import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../platform/config/env';
import { DatabaseService } from '../platform/database/database.module';
import { seedSynthetic } from './seed-synthetic';

// Development command: loads the synthetic distributor into ONE tenant (see seed-synthetic.ts).
// It runs as the application role under the tenant's own context and stops if the tenant already
// has seed data.
//
//   node dist/dev/seed-demo.js --tenant-id <uuid>

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'tenant-id': { type: 'string' } } });
  const tenantId = z.string().uuid().parse(values['tenant-id']);
  const db = new DatabaseService(loadEnv());
  try {
    const counts = await db.tenantTx(tenantId, (tx) => seedSynthetic(tx, tenantId));
    console.log(`seeded tenant ${tenantId}:`, JSON.stringify(counts));
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'seed failed');
  process.exit(1);
});
