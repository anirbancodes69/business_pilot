import { type Kysely, sql } from 'kysely';

// One row per answered question (E6.8, D-OPEN-18): who asked, which request, how it ended, and how
// much model work it took. Counts and names only. Never the question, the answer, prompts or rows.
// The application role can insert and read; it cannot change or delete a row.

const statements: string[] = [
  `CREATE TABLE core.ai_execution (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     id uuid NOT NULL DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES core.app_user(id),
     conversation_id uuid NOT NULL,
     turn integer NOT NULL,
     request_id uuid NOT NULL,
     status text NOT NULL,
     grounding text,
     planner_calls integer NOT NULL DEFAULT 0 CHECK (planner_calls >= 0),
     explainer_calls integer NOT NULL DEFAULT 0 CHECK (explainer_calls >= 0),
     input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
     output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
     model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
     duration_ms integer CHECK (duration_ms >= 0),
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, id),
     FOREIGN KEY (tenant_id, conversation_id, turn)
       REFERENCES core.conversation_turn (tenant_id, conversation_id, turn)
   )`,
  `CREATE INDEX ai_execution_by_tenant ON core.ai_execution (tenant_id, created_at DESC)`,
  `ALTER TABLE core.ai_execution ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.ai_execution FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_isolation ON core.ai_execution
     USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  `GRANT SELECT, INSERT ON core.ai_execution TO bp_app`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
