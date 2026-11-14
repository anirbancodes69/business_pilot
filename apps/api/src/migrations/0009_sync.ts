import { type Kysely, sql } from 'kysely';

// Synchronization state (E5.1, docs/data/sync-engine.md, ADR-0005). Every table carries tenant_id
// with forced RLS. Dead letters hold record keys and error codes, never row contents. Outbox
// payloads hold ids and versions only. The application role cannot delete any of these rows.
// The outbox relay needs to read across tenants: that is an RLS exception and is not built here.

const statements: string[] = [
  `CREATE TABLE core.sync_run (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     status text NOT NULL DEFAULT 'running' CHECK (status IN
       ('queued','running','succeeded','partially_failed','failed','paused')),
     trigger text NOT NULL CHECK (trigger IN ('manual','schedule','upload','activation')),
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     stats jsonb NOT NULL DEFAULT '{}'::jsonb,
     error_code text,
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id),
     UNIQUE (tenant_id, id)
   )`,
  // One running sync per source: a second run cannot start while one is running.
  `CREATE UNIQUE INDEX sync_run_one_running ON core.sync_run (tenant_id, data_source_id)
     WHERE status = 'running'`,
  `CREATE INDEX sync_run_by_source ON core.sync_run (tenant_id, data_source_id, started_at DESC)`,

  `CREATE TABLE core.sync_checkpoint (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     source_object text NOT NULL,
     cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
     schema_fingerprint text,
     last_run_id uuid,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, data_source_id, source_object),
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id)
   )`,

  `CREATE TABLE core.dataset (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     canonical_entity text NOT NULL CHECK (canonical_entity ~ '^[a-z][a-z_]*$'),
     data_version bigint NOT NULL DEFAULT 0,
     bumped_run_id uuid,
     status text NOT NULL DEFAULT 'never_synced' CHECK (status IN
       ('never_synced','fresh','failed','paused')),
     last_attempt_at timestamptz,
     last_successful_sync_at timestamptz,
     row_count bigint,
     PRIMARY KEY (tenant_id, data_source_id, canonical_entity),
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id)
   )`,

  `CREATE TABLE core.sync_dead_letter (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     run_id uuid NOT NULL,
     data_source_id uuid NOT NULL,
     source_object text NOT NULL,
     source_key text,
     field text,
     error_code text NOT NULL CHECK (length(error_code) <= 80),
     created_at timestamptz NOT NULL DEFAULT now(),
     FOREIGN KEY (tenant_id, run_id) REFERENCES core.sync_run (tenant_id, id)
   )`,
  `CREATE INDEX sync_dead_letter_by_run ON core.sync_dead_letter (tenant_id, run_id)`,

  `CREATE TABLE core.outbox_event (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     type text NOT NULL CHECK (type IN ('dataset.version_changed','document.changed',
       'mapping.activated','semantic_model.published','tenant.deletion_requested')),
     aggregate_ref text NOT NULL,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     published_at timestamptz
   )`,
  `CREATE INDEX outbox_event_unpublished ON core.outbox_event (created_at) WHERE published_at IS NULL`,
];

const tables = [
  'core.sync_run',
  'core.sync_checkpoint',
  'core.dataset',
  'core.sync_dead_letter',
  'core.outbox_event',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
  for (const t of tables) {
    await sql.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql
      .raw(
        `CREATE POLICY tenant_isolation ON ${t}
           USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
      )
      .execute(db);
  }
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.sync_run TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.sync_checkpoint TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.dataset TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT ON core.sync_dead_letter TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.outbox_event TO bp_app').execute(db);
}
