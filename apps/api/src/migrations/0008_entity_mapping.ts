import { type Kysely, sql } from 'kysely';

// Entity mappings (E4.4, schemas/configuration/entity-mapping.schema.json). One row per mapping
// document. Lifecycle: suggested, in_review, approved, active (D-10). Only an active mapping feeds
// sync (M5), and at most one mapping is active per source object.

const statements: string[] = [
  `CREATE TABLE core.entity_mapping (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     data_source_id uuid NOT NULL,
     source_object text NOT NULL CHECK (length(source_object) BETWEEN 1 AND 255),
     canonical_entity text NOT NULL CHECK (canonical_entity ~ '^[a-z][a-z_]*$'),
     status text NOT NULL DEFAULT 'suggested' CHECK (status IN
       ('suggested','in_review','approved','active','rejected','needs_review','superseded')),
     document jsonb NOT NULL,
     confidence numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     approved_by uuid,
     approved_at timestamptz,
     activated_by uuid,
     activated_at timestamptz,
     FOREIGN KEY (tenant_id, data_source_id) REFERENCES core.data_source (tenant_id, id),
     CHECK (status NOT IN ('approved','active') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX entity_mapping_one_active ON core.entity_mapping
     (tenant_id, data_source_id, source_object) WHERE status = 'active'`,
  `CREATE INDEX entity_mapping_by_source ON core.entity_mapping (tenant_id, data_source_id, created_at DESC)`,
  `ALTER TABLE core.entity_mapping ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.entity_mapping FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_isolation ON core.entity_mapping
     USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  `GRANT SELECT, INSERT, UPDATE ON core.entity_mapping TO bp_app`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
