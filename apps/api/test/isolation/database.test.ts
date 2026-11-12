import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../../src/platform/database/tenant-tx';
import type { Database } from '../../src/platform/database/database';
import { catalog, createFixture, env, fq, GLOBAL_TABLES, type Fixture } from './harness';

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(async () => f.close());

const count = async (q: ReturnType<typeof sql.raw>, db: Kysely<Database>) =>
  Number(((await q.execute(db)) as { rows: { n: string }[] }).rows[0]?.n);

describe('TI-01 no tenant context: no tenant rows, no inserts', () => {
  it('selects return zero tenant-owned rows on every RLS table', async () => {
    const tables = (await catalog(f.raw)).filter((t) => t.rls);
    expect(tables.length).toBeGreaterThan(5);
    for (const t of tables) {
      // System roles (tenant_id IS NULL) are readable by design; they hold no tenant data.
      const where = t.columns.includes('tenant_id') ? 'where tenant_id is not null' : '';
      expect(
        await count(sql.raw(`select count(*) as n from ${fq(t)} ${where}`), f.raw),
        fq(t),
      ).toBe(0);
    }
  });

  it('inserts fail without tenant context', async () => {
    const attempts = [
      sql`insert into core.tenant (name, slug) values ('x', ${'x-' + Date.now()})`,
      sql`insert into core.audit_event (tenant_id, action) values (${f.A.tenantId}, 'x')`,
      sql`insert into core.role (tenant_id, key, name) values (${f.A.tenantId}, 'x', 'x')`,
      sql`insert into core.access_policy (tenant_id, version, document) values (${f.A.tenantId}, 1, '{}')`,
    ];
    for (const a of attempts) await expect(a.execute(f.raw)).rejects.toThrow(/row-level security/);
  });

  it('an empty tenant setting (what a pooled connection keeps after SET LOCAL) behaves as no context', async () => {
    const e = env();
    const single = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: e.POSTGRES_HOST,
          port: e.POSTGRES_PORT,
          database: e.POSTGRES_DB,
          user: e.POSTGRES_APP_USER,
          password: e.POSTGRES_APP_PASSWORD,
          max: 1,
        }),
      }),
    });
    try {
      // Simulates the leftover empty string; app code never does this (see TI-03 source scan).
      await sql`select set_config('app.tenant_id', '', false)`.execute(single);
      expect(await single.selectFrom('core.tenant_membership').select('id').execute()).toEqual([]);
    } finally {
      await single.destroy();
    }
  });
});

describe('TI-02 tenant A context never returns tenant B rows (all tables, from the catalog)', () => {
  it('holds for every tenant-owned table', async () => {
    const tables = (await catalog(f.raw)).filter((t) => !GLOBAL_TABLES.has(fq(t)));
    for (const t of tables) {
      const col = t.columns.includes('tenant_id')
        ? 'tenant_id'
        : fq(t) === 'core.tenant'
          ? 'id'
          : null;
      expect(col, `${fq(t)} has no tenant key`).not.toBeNull();
      const n = await withTenantTx(f.raw, f.A.tenantId, async (tx) =>
        count(
          sql.raw(
            `select count(*) as n from ${fq(t)} where ${col} is not null and ${col} <> '${f.A.tenantId}'`,
          ),
          tx as never,
        ),
      );
      expect(n, fq(t)).toBe(0);
    }
  });

  it('tenant A sees its own rows, and a write for tenant B is rejected', async () => {
    const mine = await withTenantTx(f.raw, f.A.tenantId, (tx) =>
      tx.selectFrom('core.tenant_membership').select('id').execute(),
    );
    expect(mine.map((m) => m.id).sort()).toEqual(
      [f.A.ownerMembershipId, f.A.viewerMembershipId].sort(),
    );
    await expect(
      withTenantTx(f.raw, f.A.tenantId, (tx) =>
        tx
          .insertInto('core.audit_event')
          .values({ tenant_id: f.B.tenantId, actor_id: null, action: 'forged' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('system roles are readable by every tenant, but tenant roles are not shared', async () => {
    await withTenantTx(f.raw, f.A.tenantId, (tx) =>
      tx
        .insertInto('core.role')
        .values({ tenant_id: f.A.tenantId, key: 'custom_a', name: 'Custom A' })
        .execute(),
    );
    const seenByB = await withTenantTx(f.raw, f.B.tenantId, (tx) =>
      tx.selectFrom('core.role').select(['key', 'tenant_id']).execute(),
    );
    expect(seenByB.some((r) => r.key === 'custom_a')).toBe(false);
    expect(seenByB.some((r) => r.key === 'owner' && r.tenant_id === null)).toBe(true);
    await expect(
      withTenantTx(f.raw, f.B.tenantId, (tx) =>
        tx.insertInto('core.role').values({ tenant_id: null, key: 'sneaky', name: 'x' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('audit events are append-only for the application role', async () => {
    await withTenantTx(f.raw, f.A.tenantId, (tx) =>
      tx
        .insertInto('core.audit_event')
        .values({ tenant_id: f.A.tenantId, actor_id: null, action: 'ti02.marker' })
        .execute(),
    );
    await expect(
      withTenantTx(f.raw, f.A.tenantId, (tx) =>
        tx.updateTable('core.audit_event').set({ action: 'edited' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenantTx(f.raw, f.A.tenantId, (tx) => tx.deleteFrom('core.audit_event').execute()),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('TI-03 tenant context does not leak across pooled connections', () => {
  it('reuses one physical connection for A then B then no context', async () => {
    const e = env();
    const single = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: e.POSTGRES_HOST,
          port: e.POSTGRES_PORT,
          database: e.POSTGRES_DB,
          user: e.POSTGRES_APP_USER,
          password: e.POSTGRES_APP_PASSWORD,
          max: 1,
        }),
      }),
    });
    try {
      const pid = async () =>
        (await sql<{ p: number }>`select pg_backend_pid() as p`.execute(single)).rows[0]?.p;
      const pidA = await withTenantTx(
        single,
        f.A.tenantId,
        async (tx) =>
          (await sql<{ p: number }>`select pg_backend_pid() as p`.execute(tx)).rows[0]?.p,
      );
      const rowsB = await withTenantTx(single, f.B.tenantId, async (tx) => ({
        pid: (await sql<{ p: number }>`select pg_backend_pid() as p`.execute(tx)).rows[0]?.p,
        members: await tx.selectFrom('core.tenant_membership').select('tenant_id').execute(),
      }));
      expect(rowsB.pid).toBe(pidA); // really the same connection
      expect(rowsB.members.every((m) => m.tenant_id === f.B.tenantId)).toBe(true);
      expect(await pid()).toBe(pidA);
      const leftover = await sql<{
        t: string | null;
      }>`select core.current_tenant_id()::text as t`.execute(single);
      expect(leftover.rows[0]?.t).toBeNull();
      const visible = await single.selectFrom('core.tenant_membership').select('id').execute();
      expect(visible).toEqual([]);
    } finally {
      await single.destroy();
    }
  });

  it('application code never sets context at session level', () => {
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((n) => {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      });
    walk('src');
    const offenders = files.filter((p) => {
      const text = readFileSync(p, 'utf8');
      return (
        /set_config\(\s*'app\.[a-z_]+'\s*,[^)]*,\s*false\s*\)/i.test(text) ||
        /\bset\s+(session\s+)?app\./i.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('TI-04 catalog: every table is protected', () => {
  it('has tenant key, RLS enabled and forced, and a policy (except the documented global tables)', async () => {
    for (const t of await catalog(f.raw)) {
      if (GLOBAL_TABLES.has(fq(t))) {
        expect(t.columns.includes('tenant_id'), `${fq(t)} must hold no tenant data`).toBe(false);
        continue;
      }
      expect(
        t.columns.includes('tenant_id') || fq(t) === 'core.tenant',
        `${fq(t)} tenant key`,
      ).toBe(true);
      expect(t.rls, `${fq(t)} RLS enabled`).toBe(true);
      expect(t.forced, `${fq(t)} RLS forced`).toBe(true);
      expect(t.policies, `${fq(t)} policy`).toBeGreaterThan(0);
    }
  });

  it('the application role is not an owner, superuser or BYPASSRLS', async () => {
    const r = await sql<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(f.raw);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned =
      await sql`select tablename from pg_tables where schemaname in ('core','analytics') and tableowner = current_user`.execute(
        f.raw,
      );
    expect(owned.rows).toEqual([]);
  });

  it('the owner role and bp_system are not superuser or BYPASSRLS either', async () => {
    const r = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      select rolname, rolsuper, rolbypassrls from pg_roles where rolname in (current_user, 'bp_system', 'bp_app')`.execute(
      f.owner,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of r.rows)
      expect(row, row.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

describe('TI-15 RLS exceptions stay narrow', () => {
  it('with only app.user_id set, a user sees only their own memberships and nothing else', async () => {
    const seen = await f.db.userTx(f.A.ownerUserId, async (tx) => ({
      memberships: await tx
        .selectFrom('core.tenant_membership')
        .select(['id', 'user_id'])
        .execute(),
      tenants: await tx.selectFrom('core.tenant').select('id').execute(),
      roles: await tx.selectFrom('core.membership_role').select('membership_id').execute(),
      audit: await tx.selectFrom('core.audit_event').select('id').execute(),
      policies: await tx.selectFrom('core.access_policy').select('id').execute(),
    }));
    expect(seen.memberships.map((m) => m.user_id)).toEqual([f.A.ownerUserId]);
    expect(seen.tenants).toEqual([]);
    expect(seen.roles).toEqual([]);
    expect(seen.audit).toEqual([]);
    expect(seen.policies).toEqual([]);
  });

  it('user context cannot write memberships for another tenant or user', async () => {
    await expect(
      f.db.userTx(f.A.ownerUserId, (tx) =>
        tx
          .insertInto('core.tenant_membership')
          .values({
            tenant_id: f.B.tenantId,
            user_id: f.A.ownerUserId,
            status: 'active',
            attributes: '{}',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('only tenant_membership carries a user-keyed policy', async () => {
    const r = await sql<{ rel: string; qual: string }>`
      select c.relname as rel, pg_get_expr(p.polqual, p.polrelid) as qual
      from pg_policy p join pg_class c on c.oid = p.polrelid where pg_get_expr(p.polqual, p.polrelid) ilike '%current_user_id%'`.execute(
      f.raw,
    );
    expect(r.rows.map((x) => x.rel)).toEqual(['tenant_membership']);
  });

  it('bp_system has no grants on analytics or non-allow-listed control-plane tables', async () => {
    await f.owner.transaction().execute(async (tx) => {
      await sql`set local role bp_system`.execute(tx);
      const tables = (await catalog(tx)).filter((t) => fq(t) !== 'core.tenant');
      for (const t of tables) {
        const priv = await sql<{
          ok: boolean;
        }>`select has_table_privilege('bp_system', ${fq(t)}, 'SELECT,INSERT,UPDATE,DELETE') as ok`.execute(
          tx,
        );
        expect(priv.rows[0]?.ok, `${fq(t)}`).toBe(false);
      }
      // allowed: tenant id and status only
      const ok = await sql`select id, status from core.tenant limit 1`.execute(tx);
      expect(ok.rows.length).toBeGreaterThan(0);
    });
    for (const q of [
      sql`select * from core.audit_event`,
      sql`select * from core.tenant_membership`,
      sql`select wrapped_data_key from core.tenant`,
    ]) {
      await expect(
        f.owner.transaction().execute(async (tx) => {
          await sql`set local role bp_system`.execute(tx);
          await q.execute(tx);
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
