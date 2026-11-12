import { type Kysely, sql } from 'kysely';

// Seeds the permission catalog and system roles. Entity and measure permissions
// (entity:*:read, measure:*:read) are added with the semantic model in Milestone 3.

export const PERMISSIONS: Record<string, string> = {
  'tenant:read': 'View tenant details',
  'tenant:manage': 'Change tenant settings',
  'user:read': 'List members of the tenant',
  'user:manage': 'Change members and their roles',
  'audit:read': 'Read the audit log',
  'data_source:manage': 'Create and change data sources',
  'mapping:approve': 'Approve entity mappings',
  'semantic_model:manage': 'Edit semantic model drafts',
  'semantic_model:publish': 'Publish semantic model versions',
};

const ALL = Object.keys(PERMISSIONS);

export const SYSTEM_ROLES: Record<string, { name: string; permissions: string[] }> = {
  owner: { name: 'Owner', permissions: ALL },
  tenant_admin: { name: 'Tenant admin', permissions: ALL },
  finance_manager: { name: 'Finance manager', permissions: ['tenant:read'] },
  sales_manager: { name: 'Sales manager', permissions: ['tenant:read'] },
  sales_executive: { name: 'Sales executive', permissions: ['tenant:read'] },
  viewer: { name: 'Viewer', permissions: ['tenant:read'] },
};

export async function up(db: Kysely<unknown>): Promise<void> {
  // The owner is subject to FORCE ROW LEVEL SECURITY. System rows (tenant_id NULL) are seeded
  // with FORCE switched off for the duration of this migration only.
  await sql.raw('ALTER TABLE core.role NO FORCE ROW LEVEL SECURITY').execute(db);
  await sql.raw('ALTER TABLE core.role_permission NO FORCE ROW LEVEL SECURITY').execute(db);
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await sql`INSERT INTO core.permission (key, description) VALUES (${key}, ${description})`.execute(
      db,
    );
  }
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const res = await sql<{ id: string }>`
      INSERT INTO core.role (tenant_id, key, name) VALUES (NULL, ${key}, ${role.name}) RETURNING id`.execute(
      db,
    );
    const roleId = res.rows[0]?.id;
    if (!roleId) throw new Error('seed failed');
    for (const p of role.permissions) {
      await sql`INSERT INTO core.role_permission (tenant_id, role_id, permission_key)
                VALUES (NULL, ${roleId}, ${p})`.execute(db);
    }
  }
  await sql.raw('ALTER TABLE core.role FORCE ROW LEVEL SECURITY').execute(db);
  await sql.raw('ALTER TABLE core.role_permission FORCE ROW LEVEL SECURITY').execute(db);
}
