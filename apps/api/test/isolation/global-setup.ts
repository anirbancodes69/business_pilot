import { existsSync } from 'node:fs';
import { migrateToLatest } from '../../src/platform/database/migrate';

// Loads ../../.env when present (CI sets the variables directly), then migrates as bp_owner.
export default async function setup(): Promise<void> {
  if (!process.env.POSTGRES_APP_PASSWORD && existsSync('../../.env'))
    process.loadEnvFile('../../.env');
  process.env.POSTGRES_HOST ??= '127.0.0.1';
  // Syncs queued by the API under test must never reach a running worker.
  process.env.SYNC_QUEUE_NAME ??= 'test_isolation';
  await migrateToLatest();
}
