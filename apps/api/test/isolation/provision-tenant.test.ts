import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant, ProvisionError } from '../../src/tenancy/provision-tenant';
import { createFixture, type Fixture } from './harness';

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(async () => f.close());

const run = randomUUID().slice(0, 8);
const deps = () => ({ identity: f.identity, tenancy: f.tenancy });

const ownerRoles = (tenantId: string, userId: string) =>
  f.db.tenantTx(tenantId, (tx) =>
    tx
      .selectFrom('core.tenant_membership as m')
      .innerJoin('core.membership_role as mr', 'mr.membership_id', 'm.id')
      .innerJoin('core.role as r', 'r.id', 'mr.role_id')
      .select(['m.status', 'r.key'])
      .where('m.user_id', '=', userId)
      .execute(),
  );

describe('operator tenant provisioning', () => {
  it('creates a tenant for a subject that never signed in, and sign-in then fills in the profile', async () => {
    const subject = `sub-${run}-new`;
    const { tenantId, ownerUserId } = await provisionTenant(deps(), {
      name: 'New Traders',
      slug: `new-${run}`,
      ownerSubject: subject,
    });
    expect(await ownerRoles(tenantId, ownerUserId)).toEqual([{ status: 'active', key: 'owner' }]);
    const signedIn = await f.identity.resolveUser({
      subject,
      email: 'new@example.test',
      name: 'N',
    });
    expect(signedIn?.id).toBe(ownerUserId);
    expect((await f.identity.listMemberships(ownerUserId)).map((m) => m.tenant_id)).toEqual([
      tenantId,
    ]);
  });

  it('does not overwrite the profile of an existing user found by subject', async () => {
    const subject = `sub-${run}-known`;
    const email = `known-${run}@example.test`;
    const user = await f.identity.resolveUser({ subject, email, name: 'Known' });
    const { ownerUserId } = await provisionTenant(deps(), {
      name: 'Known Traders',
      slug: `known-${run}`,
      ownerSubject: subject,
    });
    expect(ownerUserId).toBe(user?.id);
    expect((await f.identity.findUsersByEmail(email)).map((u) => u.id)).toEqual([user?.id]);
  });

  it('finds the owner by email without case, and the new tenant is invisible to other tenants', async () => {
    const email = `Owner-${run}@Example.test`;
    const user = await f.identity.resolveUser({ subject: `sub-${run}-mail`, email, name: 'O' });
    const { tenantId, ownerUserId } = await provisionTenant(deps(), {
      name: 'Acme Traders', // same name as the fixture tenants
      slug: `mail-${run}`,
      ownerEmail: email.toUpperCase(),
    });
    expect(ownerUserId).toBe(user?.id);
    // Tenant A sees neither the new tenant nor its membership, and its own owner gained nothing.
    const seenFromA = await f.db.tenantTx(f.A.tenantId, async (tx) => ({
      tenants: (await tx.selectFrom('core.tenant').select('id').execute()).map((t) => t.id),
      members: (await tx.selectFrom('core.tenant_membership').select('user_id').execute()).map(
        (m) => m.user_id,
      ),
    }));
    expect(seenFromA.tenants).toEqual([f.A.tenantId]);
    expect(seenFromA.members).not.toContain(ownerUserId);
    expect((await f.identity.listMemberships(f.A.ownerUserId)).map((m) => m.tenant_id)).toEqual([
      f.A.tenantId,
    ]);
    // The audit event is recorded inside the new tenant only.
    const events = await f.db.tenantTx(tenantId, (tx) =>
      tx.selectFrom('core.audit_event').select(['action', 'tenant_id']).execute(),
    );
    expect(events).toEqual([{ action: 'tenant.provisioned', tenant_id: tenantId }]);
  });

  it('refuses an unknown email, an ambiguous email and a slug that is taken', async () => {
    await expect(
      provisionTenant(deps(), {
        name: 'X',
        slug: `x-${run}`,
        ownerEmail: `nobody-${run}@example.test`,
      }),
    ).rejects.toThrow(/no user has this email/);

    // The fixture creates two users named Asha with the same email.
    await expect(
      provisionTenant(deps(), { name: 'X', slug: `x-${run}`, ownerEmail: 'asha@example.test' }),
    ).rejects.toThrow(/several users have this email/);

    const subject = `sub-${run}-dup`;
    await provisionTenant(deps(), { name: 'Dup', slug: `dup-${run}`, ownerSubject: subject });
    const again = provisionTenant(deps(), {
      name: 'Dup 2',
      slug: `dup-${run}`,
      ownerSubject: subject,
    });
    await expect(again).rejects.toBeInstanceOf(ProvisionError);
    await expect(again).rejects.toThrow('this slug is already in use');
    // The failed attempt left nothing behind: the user still owns exactly one tenant.
    const user = await f.identity.ensureUserBySubject(subject);
    expect(await f.identity.listMemberships(user.id)).toHaveLength(1);
  });
});
