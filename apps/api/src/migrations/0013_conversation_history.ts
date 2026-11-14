import { type Kysely, sql } from 'kysely';

// Conversation history (ADR-0021). A user can come back to their conversations, so a turn now keeps
// the question and the answer as shown. They belong to that user only (the api filters by user, RLS
// keeps tenants apart), are kept for a retention period, and the user can delete a conversation.
// Audit events and logs still never carry question or answer text.
//
// Usage metering (core.ai_execution) must outlive a deleted conversation, so its link to the turn
// becomes a plain pair of ids.

const statements: string[] = [
  `ALTER TABLE core.conversation_turn ADD COLUMN question text`,
  `ALTER TABLE core.conversation_turn ADD COLUMN answer jsonb`,
  `DO $$
   DECLARE c text;
   BEGIN
     SELECT conname INTO c FROM pg_constraint
      WHERE conrelid = 'core.ai_execution'::regclass AND contype = 'f'
        AND confrelid = 'core.conversation_turn'::regclass;
     IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE core.ai_execution DROP CONSTRAINT %I', c); END IF;
   END $$`,
  `GRANT DELETE ON core.conversation_turn, core.conversation TO bp_app`,
  `CREATE INDEX conversation_turn_recent ON core.conversation_turn (tenant_id, conversation_id, created_at DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
