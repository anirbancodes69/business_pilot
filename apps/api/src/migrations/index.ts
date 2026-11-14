import type { Migration, MigrationProvider } from 'kysely';
import * as m0001 from './0001_control_plane';
import * as m0002 from './0002_system_roles';
import * as m0003 from './0003_semantic_model';
import * as m0004 from './0004_analytics_wholesale';
import * as m0005 from './0005_one_active_policy';
import * as m0006 from './0006_data_sources';
import * as m0007 from './0007_uploads_and_objects';
import * as m0008 from './0008_entity_mapping';
import * as m0009 from './0009_sync';
import * as m0010 from './0010_notifications_and_outbox_retention';

// Forward-only migrations (ADR-0009). Names sort in application order. No down migrations.
const migrations: Record<string, Migration> = {
  '0001_control_plane': { up: m0001.up },
  '0002_system_roles': { up: m0002.up },
  '0003_semantic_model': { up: m0003.up },
  '0004_analytics_wholesale': { up: m0004.up },
  '0005_one_active_policy': { up: m0005.up },
  '0006_data_sources': { up: m0006.up },
  '0007_uploads_and_objects': { up: m0007.up },
  '0008_entity_mapping': { up: m0008.up },
  '0009_sync': { up: m0009.up },
  '0010_notifications_and_outbox_retention': { up: m0010.up },
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
