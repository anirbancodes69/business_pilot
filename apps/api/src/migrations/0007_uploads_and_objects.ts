import { type Kysely, sql } from 'kysely';

// Uploaded files and the objects (tables, sheets) a customer chose for a data source (E4.2, E4.4).
// A file's bytes live in object storage under tenants/{tenant_id}/; only metadata is stored here.
// Nothing is read from a source unless its object is approved by a human (D-10).

const statements: string[] = [
  `CREATE TABLE core.data_source_upload (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     object_key text NOT NULL,
     file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
     size_bytes bigint NOT NULL CHECK (size_bytes > 0),
     sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id)
   )`,
  `CREATE INDEX data_source_upload_latest ON core.data_source_upload
     (tenant_id, data_source_id, created_at DESC)`,
  `CREATE TABLE core.data_source_object (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
     key_columns jsonb NOT NULL DEFAULT '[]',
     approved boolean NOT NULL DEFAULT false,
     approved_by uuid,
     approved_at timestamptz,
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, data_source_id, name),
     CHECK (NOT approved OR jsonb_array_length(key_columns) > 0),
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id)
   )`,
];

const tables = ['core.data_source_upload', 'core.data_source_object'];

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
  // Uploads are immutable records. Objects are edited by their selectors and approvers.
  await sql.raw('GRANT SELECT, INSERT ON core.data_source_upload TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.data_source_object TO bp_app').execute(db);
}
