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
