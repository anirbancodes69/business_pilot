import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { IdentityService } from '../identity/identity.service';
import { loadEnv } from '../platform/config/env';
import { EnvelopeCrypto } from '../platform/crypto/envelope';
import { LocalKeyManagement } from '../platform/crypto/key-management';
import { DatabaseService } from '../platform/database/database.module';
import { TenancyService } from './tenancy.service';

// Operator command: creates a tenant and makes one user its owner. There is no HTTP route for this
// (self-service sign-up and invitations are a later milestone). Whoever can run it holds the
// application database credentials and the key-encryption key, so it needs no further login.
//
//   node dist/tenancy/provision-tenant.js --name "Acme Traders" --slug acme --owner-email a@acme.test
//   node dist/tenancy/provision-tenant.js --name "Acme Traders" --slug acme --owner-subject <oidc sub>

export const USAGE =
  'usage: provision-tenant --name <name> --slug <slug> (--owner-email <email> | --owner-subject <oidc subject>)';

/** A message that is safe to show to the operator as it is. */
export class ProvisionError extends Error {}

const input = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
    ownerEmail: z.string().trim().email().max(320).optional(),
    ownerSubject: z.string().min(1).max(255).optional(),
  })
  .refine((v) => (v.ownerEmail === undefined) !== (v.ownerSubject === undefined));

export type ProvisionInput = z.infer<typeof input>;

export function parseProvisionArgs(argv: string[]): ProvisionInput {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        slug: { type: 'string' },
        'owner-email': { type: 'string' },
        'owner-subject': { type: 'string' },
      },
    }));
  } catch {
    throw new ProvisionError(USAGE);
  }
  const parsed = input.safeParse({
    name: values.name,
    slug: values.slug,
    ownerEmail: values['owner-email'],
    ownerSubject: values['owner-subject'],
  });
  if (!parsed.success)
    throw new ProvisionError(
      `${USAGE}\nThe slug is lower-case letters, digits and hyphens (1 to 63 characters). Give exactly one owner option.`,
    );
  return parsed.data;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}

export async function provisionTenant(
  deps: { identity: IdentityService; tenancy: TenancyService },
  args: ProvisionInput,
): Promise<{ tenantId: string; ownerUserId: string }> {
  let owner: { id: string; status: string };
  if (args.ownerSubject !== undefined) {
    owner = await deps.identity.ensureUserBySubject(args.ownerSubject);
  } else {
    const matches = await deps.identity.findUsersByEmail(args.ownerEmail ?? '');
    if (matches.length === 0)
      throw new ProvisionError(
        'no user has this email. The user must sign in once first (any authenticated call, such as GET /v1/me), or use --owner-subject.',
      );
    if (matches.length > 1 || !matches[0])
      throw new ProvisionError('several users have this email. Use --owner-subject instead.');
    owner = matches[0];
  }
  if (owner.status !== 'active') throw new ProvisionError('this user is disabled');
  try {
    const tenantId = await deps.tenancy.provision({
      name: args.name,
      slug: args.slug,
      ownerUserId: owner.id,
    });
    return { tenantId, ownerUserId: owner.id };
  } catch (e) {
    if (isUniqueViolation(e)) throw new ProvisionError('this slug is already in use');
    throw e;
  }
}

async function main(): Promise<void> {
  const args = parseProvisionArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.LOCAL_KEK_BASE64)
    throw new ProvisionError('key management is not configured (LOCAL_KEK_BASE64)');
  const db = new DatabaseService(env);
  try {
    const crypto = new EnvelopeCrypto(new LocalKeyManagement(env.LOCAL_KEK_BASE64));
    const result = await provisionTenant(
      {
        identity: new IdentityService(db),
        tenancy: new TenancyService(db, new AuditService(), crypto),
      },
      args,
    );
    console.log(`tenant_id=${result.tenantId}`);
    console.log(`owner_user_id=${result.ownerUserId}`);
  } finally {
    await db.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    // Driver errors can carry connection details, so only known messages are printed.
    console.error(e instanceof ProvisionError ? e.message : 'provisioning failed');
    process.exit(1);
  });
}
