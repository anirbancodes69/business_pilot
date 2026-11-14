import { type Kysely, sql } from 'kysely';

// Conversations (E6.2, D-21). A turn stores the typed analytical context and a status. It never
// stores the question text, result rows, figures or the answer: those would carry tenant data into
// a table with a long life (ADR-0011). Rows belong to one user; the API checks that on every load,
// and RLS keeps tenants apart. The application role cannot update or delete a turn.

const statements: string[] = [
  `CREATE TABLE core.conversation (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES core.app_user(id),
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, id)
   )`,
  `CREATE TABLE core.conversation_turn (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     conversation_id uuid NOT NULL,
     turn integer NOT NULL CHECK (turn >= 1),
     analytical_context jsonb NOT NULL,
     status text NOT NULL,
     plan_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, conversation_id, turn),
     FOREIGN KEY (tenant_id, conversation_id) REFERENCES core.conversation (tenant_id, id)
   )`,
  `CREATE INDEX conversation_by_user ON core.conversation (tenant_id, user_id, created_at DESC)`,
];
for (const table of ['core.conversation', 'core.conversation_turn']) {
  statements.push(
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
    `GRANT SELECT, INSERT ON ${table} TO bp_app`,
  );
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
