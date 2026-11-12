import { type Kysely, sql } from 'kysely';

// Control-plane schema (docs/architecture/tenant-model.md) with forced RLS (SECURITY.md section 4).
// Runs as bp_owner. Roles bp_app and bp_system are created by infrastructure/postgres/init.
// Tenant context comes from app.tenant_id, set per transaction by withTenantTx (never at session level).

const statements: string[] = [
  `CREATE SCHEMA core`,
  `GRANT USAGE ON SCHEMA core TO bp_app, bp_system`,

  // Context helpers. NULLIF guards the empty string that a pooled connection keeps after a
  // transaction-local setting expires (an empty string cast to uuid would raise an error).
  `CREATE FUNCTION core.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE
     AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$`,
  `CREATE FUNCTION core.current_user_id() RETURNS uuid LANGUAGE sql STABLE
     AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$`,
  `GRANT EXECUTE ON FUNCTION core.current_tenant_id(), core.current_user_id() TO bp_app, bp_system`,

  // --- tenant (keyed by id; RLS compares id to the tenant context) ---
  `CREATE TABLE core.tenant (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     name text NOT NULL,
     slug text NOT NULL UNIQUE,
     status text NOT NULL DEFAULT 'provisioning'
       CHECK (status IN ('provisioning','active','suspended','deleting','deleted')),
     region text,
     plan text,
     template_id text,
     key_id text,
     wrapped_data_key bytea,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE core.tenant ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.tenant FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_isolation ON core.tenant
     USING (id = core.current_tenant_id()) WITH CHECK (id = core.current_tenant_id())`,
  // P-15 exception 2: worker system tasks may read and update tenant status only.
  `CREATE POLICY system_status ON core.tenant TO bp_system USING (true) WITH CHECK (true)`,
  `GRANT SELECT, INSERT, UPDATE ON core.tenant TO bp_app`,
  `GRANT SELECT (id, status), UPDATE (status) ON core.tenant TO bp_system`,

  // --- app_user: global identity, no tenant data, no RLS (allow-listed, ADR-0014) ---
  `CREATE TABLE core.app_user (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     idp_subject text NOT NULL UNIQUE,
     email text,
     display_name text,
     status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `GRANT SELECT, INSERT, UPDATE (email, display_name) ON core.app_user TO bp_app`,

  // --- permission: global catalog (allow-listed, read-only for the application) ---
  `CREATE TABLE core.permission (key text PRIMARY KEY, description text NOT NULL)`,
  `GRANT SELECT ON core.permission TO bp_app`,

  // --- role and role_permission: tenant_id NULL = system role, readable by all tenants, writable by none ---
  `CREATE TABLE core.role (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid REFERENCES core.tenant(id),
     key text NOT NULL,
     name text NOT NULL,
     UNIQUE NULLS NOT DISTINCT (tenant_id, key)
   )`,
  `CREATE TABLE core.role_permission (
     tenant_id uuid REFERENCES core.tenant(id),
     role_id uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
     permission_key text NOT NULL REFERENCES core.permission(key),
     PRIMARY KEY (role_id, permission_key)
   )`,

  // --- tenant_membership ---
  `CREATE TABLE core.tenant_membership (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     user_id uuid NOT NULL REFERENCES core.app_user(id),
     status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
     attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, user_id)
   )`,
  `CREATE TABLE core.membership_role (
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     membership_id uuid NOT NULL REFERENCES core.tenant_membership(id) ON DELETE CASCADE,
     role_id uuid NOT NULL REFERENCES core.role(id),
     PRIMARY KEY (membership_id, role_id)
   )`,

  // --- access_policy (document validated by schemas/tenant/access-policy.schema.json) ---
  `CREATE TABLE core.access_policy (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     version integer NOT NULL CHECK (version >= 1),
     document jsonb NOT NULL,
     status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, version)
   )`,

  // --- audit_event: append-only for the application (no UPDATE or DELETE grant) ---
  `CREATE TABLE core.audit_event (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL REFERENCES core.tenant(id),
     actor_id uuid,
     action text NOT NULL,
     target text,
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     occurred_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX audit_event_tenant_time ON core.audit_event (tenant_id, occurred_at DESC)`,

  // --- RLS for every tenant-owned table ---
  ...['tenant_membership', 'membership_role', 'access_policy', 'audit_event'].flatMap((t) => [
    `ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON core.${t}
       USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  ]),
  // P-15 exception 1: a user may list only their own memberships before a tenant is selected.
  `CREATE POLICY own_membership ON core.tenant_membership FOR SELECT
     USING (user_id = core.current_user_id())`,
  ...['role', 'role_permission'].flatMap((t) => [
    `ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY read_own_and_system ON core.${t} FOR SELECT
       USING (tenant_id IS NULL OR tenant_id = core.current_tenant_id())`,
    `CREATE POLICY tenant_write ON core.${t} FOR ALL
       USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())`,
  ]),

  `GRANT SELECT, INSERT, UPDATE, DELETE ON core.tenant_membership, core.membership_role,
     core.role, core.role_permission TO bp_app`,
  `GRANT SELECT, INSERT, UPDATE ON core.access_policy TO bp_app`,
  `GRANT SELECT, INSERT ON core.audit_event TO bp_app`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const text of statements) await sql.raw(text).execute(db);
}
