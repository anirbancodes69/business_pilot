import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../platform/database/database.module';
import type { VerifiedIdentity } from './token-verifier';

@Injectable()
export class IdentityService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Finds or creates the app_user for an OIDC subject. Returns null for disabled users. */
  async resolveUser(identity: VerifiedIdentity): Promise<{ id: string } | null> {
    return this.db.identityTx(async (tx) => {
      const row = await tx
        .insertInto('core.app_user')
        .values({
          idp_subject: identity.subject,
          email: identity.email,
          display_name: identity.name,
        })
        .onConflict((oc) =>
          oc
            .column('idp_subject')
            .doUpdateSet({ email: identity.email, display_name: identity.name }),
        )
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      return row.status === 'active' ? { id: row.id } : null;
    });
  }

  /**
   * Operator lookups for tenant provisioning. Not reachable over HTTP. Emails are compared without
   * case. An email is not unique, so the caller must handle zero or several matches.
   */
  findUsersByEmail(email: string): Promise<{ id: string; status: string }[]> {
    return this.db.identityTx((tx) =>
      tx
        .selectFrom('core.app_user')
        .select(['id', 'status'])
        .where((eb) => eb(eb.fn<string>('lower', ['email']), '=', email.toLowerCase()))
        .execute(),
    );
  }

  /**
   * Finds the user for an OIDC subject, or creates an empty one. Unlike `resolveUser` it never
   * overwrites the email or name of an existing user. Sign-in fills them in later.
   */
  ensureUserBySubject(subject: string): Promise<{ id: string; status: string }> {
    return this.db.identityTx(async (tx) => {
      await tx
        .insertInto('core.app_user')
        .values({ idp_subject: subject, email: null, display_name: null })
        .onConflict((oc) => oc.column('idp_subject').doNothing())
        .execute();
      return tx
        .selectFrom('core.app_user')
        .select(['id', 'status'])
        .where('idp_subject', '=', subject)
        .executeTakeFirstOrThrow();
    });
  }

  /** Memberships of one user, via the single login exception (P-15, own memberships only). */
  listMemberships(userId: string) {
    return this.db.userTx(userId, (tx) =>
      tx
        .selectFrom('core.tenant_membership')
        .select(['id', 'tenant_id', 'status'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
    );
  }
}
