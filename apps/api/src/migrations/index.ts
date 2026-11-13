import type { Migration, MigrationProvider } from 'kysely';
import * as m0001 from './0001_control_plane';
import * as m0002 from './0002_system_roles';
import * as m0003 from './0003_semantic_model';
import * as m0004 from './0004_analytics_wholesale';
import * as m0005 from './0005_one_active_policy';

// Forward-only migrations (ADR-0009). Names sort in application order. No down migrations.
const migrations: Record<string, Migration> = {
  '0001_control_plane': { up: m0001.up },
  '0002_system_roles': { up: m0002.up },
  '0003_semantic_model': { up: m0003.up },
  '0004_analytics_wholesale': { up: m0004.up },
  '0005_one_active_policy': { up: m0005.up },
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
