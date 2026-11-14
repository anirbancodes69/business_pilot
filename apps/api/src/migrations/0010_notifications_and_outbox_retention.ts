import { type Kysely, sql } from 'kysely';

// Administrator notifications (E5.3, E5.5) and outbox retention (ADR-0017).
// A notification holds a kind, a data source and codes. Never row values or credentials.
// The application role may delete published outbox events and nothing else: a restrictive policy
// makes an unpublished event undeletable, so a bug cannot silently drop pending work.

const statements: string[] = [
  `CREATE TABLE core.notification (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     kind text NOT NULL CHECK (kind IN
       ('sync.paused_schema_drift','sync.auth_failed','sync.failed')),
     severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
     data_source_id uuid,
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     read_at timestamptz,
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id)
   )`,
  `CREATE INDEX notification_by_tenant ON core.notification (tenant_id, created_at DESC)`,
  `ALTER TABLE core.notification ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.notification FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_isolation ON core.notification
     USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  `GRANT SELECT, INSERT, UPDATE ON core.notification TO bp_app`,

  `CREATE POLICY delete_published_only ON core.outbox_event AS RESTRICTIVE FOR DELETE
     USING (published_at IS NOT NULL)`,
  `GRANT DELETE ON core.outbox_event TO bp_app`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
