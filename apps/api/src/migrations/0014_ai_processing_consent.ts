import { type Kysely, sql } from 'kysely';

// A workspace must say yes before its questions and result figures are sent to the AI model
// provider (ADR-0022, docs/security/llm-data-processing-review.md). Off by default.

const statements: string[] = [
  `ALTER TABLE core.tenant ADD COLUMN ai_processing_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE core.tenant ADD COLUMN ai_processing_changed_at timestamptz`,
  `ALTER TABLE core.tenant ADD COLUMN ai_processing_changed_by uuid`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
