import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
import { loadEnv } from '../config/env';
import { createDb } from './database';

// Forward-only migrations (ADR-0009). Runs as bp_owner. Migrations live in apps/api/migrations
// (compiled output is not used: migration files are plain .js or compiled .ts in dist/migrations).
async function main(): Promise<void> {
  const db = createDb(loadEnv(), 'owner');
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(__dirname, '../../../migrations'),
    }),
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName}`);
  await db.destroy();
  if (error) {
    console.error('Migration failed', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
