import { type Kysely, sql } from 'kysely';

// Data sources and connector credentials (E4.1). Credentials are stored only as envelope-encrypted
// ciphertext (P-12). A data source holds non-secret connection parameters and a credential reference.

const statements: string[] = [
  `CREATE TABLE core.connector_credential (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     key_id text NOT NULL,
     ciphertext bytea NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, id)
   )`,
  `CREATE TABLE core.data_source (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
     type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*$'),
     access_mode text NOT NULL CHECK (access_mode IN ('managed_sync','live_federated')),
     connection jsonb NOT NULL,
     credential_id uuid,
     status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','connected','error','disabled')),
     last_tested_at timestamptz,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, id),
     UNIQUE (tenant_id, name),
     FOREIGN KEY (tenant_id, credential_id) REFERENCES core.connector_credential (tenant_id, id)
   )`,
];

const tables = ['core.connector_credential', 'core.data_source'];

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
  // Credentials are replaced by inserting a new row, never edited in place.
  await sql.raw('GRANT SELECT, INSERT, DELETE ON core.connector_credential TO bp_app').execute(db);
  await sql.raw('GRANT SELECT, INSERT, UPDATE ON core.data_source TO bp_app').execute(db);
}
