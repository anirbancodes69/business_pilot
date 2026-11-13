import { type Kysely, sql } from 'kysely';

// Semantic model versions (E3.1). Documents are validated by the api against
// schemas/semantic-model/semantic-model.schema.json. A published version is immutable (P-13):
// the trigger below enforces it even against a faulty application.

const statements: string[] = [
  `CREATE TABLE core.semantic_model (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     version integer NOT NULL CHECK (version >= 1),
     status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
     document jsonb NOT NULL,
     created_by uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     published_by uuid,
     published_at timestamptz,
     UNIQUE (tenant_id, version)
   )`,
  // At most one published version per tenant.
  `CREATE UNIQUE INDEX semantic_model_one_published ON core.semantic_model (tenant_id)
     WHERE status = 'published'`,
  `ALTER TABLE core.semantic_model ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.semantic_model FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_isolation ON core.semantic_model
     USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  `GRANT SELECT, INSERT, UPDATE ON core.semantic_model TO bp_app`,

  `CREATE FUNCTION core.semantic_model_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF OLD.status <> 'draft' AND (
          NEW.document IS DISTINCT FROM OLD.document OR NEW.version <> OLD.version
          OR NEW.tenant_id <> OLD.tenant_id) THEN
       RAISE EXCEPTION 'published semantic model versions are immutable';
     END IF;
     IF OLD.status = 'published' AND NEW.status NOT IN ('published','retired') THEN
       RAISE EXCEPTION 'invalid semantic model status change';
     END IF;
     IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
       RAISE EXCEPTION 'a retired semantic model cannot be reactivated';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER semantic_model_guard BEFORE UPDATE ON core.semantic_model
     FOR EACH ROW EXECUTE FUNCTION core.semantic_model_guard()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
