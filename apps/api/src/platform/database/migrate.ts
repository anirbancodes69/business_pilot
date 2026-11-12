import { Migrator } from 'kysely';
import { migrationProvider } from '../../migrations';
import { loadEnv } from '../config/env';
import { createDb } from './database';

// Forward-only migrations (ADR-0009). Runs as bp_owner, never as the application role.
export async function migrateToLatest(role: 'owner' = 'owner'): Promise<string[]> {
  const db = createDb(loadEnv(), role);
  try {
    const { error, results } = await new Migrator({
      db,
      provider: migrationProvider,
    }).migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error(String(error));
    return (results ?? []).map((r) => `${r.status}: ${r.migrationName}`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  migrateToLatest().then(
    (lines) => lines.forEach((l) => console.log(l)),
    (err: unknown) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
