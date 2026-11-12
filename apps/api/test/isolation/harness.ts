import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AuditService } from '../../src/audit/audit.service';
import { IdentityService } from '../../src/identity/identity.service';
import { loadEnv } from '../../src/platform/config/env';
import { EnvelopeCrypto } from '../../src/platform/crypto/envelope';
import { LocalKeyManagement } from '../../src/platform/crypto/key-management';
import { createDb, type Database } from '../../src/platform/database/database';
import { DatabaseService } from '../../src/platform/database/database.module';
import { TenancyService } from '../../src/tenancy/tenancy.service';

export const env = () => loadEnv();

/** Two tenants with deliberately overlapping names, emails and role keys, so a leak is visible. */
export interface Fixture {
  db: DatabaseService;
  raw: Kysely<Database>; // bp_app connection without tenant context helpers
  owner: Kysely<Database>; // bp_owner (used only to assume bp_system in TI-15)
  identity: IdentityService;
  tenancy: TenancyService;
  A: {
    tenantId: string;
    ownerUserId: string;
    viewerUserId: string;
    ownerMembershipId: string;
    viewerMembershipId: string;
  };
  B: { tenantId: string; ownerUserId: string; ownerMembershipId: string };
  subjects: Record<string, string>; // token -> idp subject
  close: () => Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const e = env();
  const db = new DatabaseService(e);
  const raw = createDb(e, 'app');
  const owner = createDb(e, 'owner');
  const identity = new IdentityService(db);
  const crypto = new EnvelopeCrypto(new LocalKeyManagement(randomBytes(32).toString('base64')));
  const tenancy = new TenancyService(db, new AuditService(), crypto);
  const run = randomUUID().slice(0, 8);
  const mk = async (tag: string, name: string) => {
    const subject = `sub-${run}-${tag}`;
    const user = await identity.resolveUser({
      subject,
      email: `${name.toLowerCase()}@example.test`,
      name,
    });
    if (!user) throw new Error('user not created');
    return { subject, id: user.id };
  };
  const ownerA = await mk('ownerA', 'Asha'); // same display name in both tenants
  const viewerA = await mk('viewerA', 'Vikram');
  const ownerB = await mk('ownerB', 'Asha');

  const tenantA = await tenancy.provision({
    name: 'Acme Traders',
    slug: `acme-${run}`,
    ownerUserId: ownerA.id,
  });
  const tenantB = await tenancy.provision({
    name: 'Acme Traders',
    slug: `acme-b-${run}`,
    ownerUserId: ownerB.id,
  });

  const membershipOf = (tenantId: string, userId: string) =>
    db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.tenant_membership')
        .select('id')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    );
  const viewerMembership = await db.tenantTx(tenantA, async (tx) => {
    const m = await tx
      .insertInto('core.tenant_membership')
      .values({
        tenant_id: tenantA,
        user_id: viewerA.id,
        status: 'active',
        attributes: '{"assigned_branch_ids":["b1"]}',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const role = await tx
      .selectFrom('core.role')
      .select('id')
      .where('key', '=', 'viewer')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('core.membership_role')
      .values({ tenant_id: tenantA, membership_id: m.id, role_id: role.id })
      .execute();
    return m;
  });

  return {
    db,
    raw,
    owner,
    identity,
    tenancy,
    A: {
      tenantId: tenantA,
      ownerUserId: ownerA.id,
      viewerUserId: viewerA.id,
      ownerMembershipId: (await membershipOf(tenantA, ownerA.id)).id,
      viewerMembershipId: viewerMembership.id,
    },
    B: {
      tenantId: tenantB,
      ownerUserId: ownerB.id,
      ownerMembershipId: (await membershipOf(tenantB, ownerB.id)).id,
    },
    subjects: { ownerA: ownerA.subject, viewerA: viewerA.subject, ownerB: ownerB.subject },
    close: async () => {
      await db.onModuleDestroy();
      await raw.destroy();
      await owner.destroy();
    },
  };
}

export interface CatalogTable {
  schema: string;
  name: string;
  rls: boolean;
  forced: boolean;
  columns: string[];
  policies: number;
}

/** Reads every table in schemas core and analytics from the catalog, so new tables are covered automatically. */
export async function catalog(db: Kysely<Database>): Promise<CatalogTable[]> {
  const res = await sql<{
    schema: string;
    name: string;
    rls: boolean;
    forced: boolean;
    columns: string[];
    policies: string;
  }>`
    select n.nspname as schema, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select coalesce(array_agg(a.attname::text), '{}') from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
      (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('core', 'analytics')
    order by 1, 2`.execute(db);
  return res.rows.map((r) => ({ ...r, policies: Number(r.policies) }));
}

// Global (non-tenant) tables: no tenant data, no RLS. This allow-list is documented in ADR-0014.
export const GLOBAL_TABLES = new Set(['core.app_user', 'core.permission']);
export const fq = (t: CatalogTable): string => `${t.schema}.${t.name}`;
