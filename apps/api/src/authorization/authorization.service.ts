import { Injectable } from '@nestjs/common';
import type { Tx } from '../platform/database/tenant-tx';
import { type AuthorizationContext, buildAuthorizationContext } from './authorization';

@Injectable()
export class AuthorizationService {
  /** Must run inside the tenant's transaction: RLS then limits roles to system roles plus this tenant's. */
  async load(
    tx: Tx,
    tenantId: string,
    userId: string,
    membershipId: string,
  ): Promise<AuthorizationContext> {
    const roles = await tx
      .selectFrom('core.membership_role as mr')
      .innerJoin('core.role as r', 'r.id', 'mr.role_id')
      .select(['r.id as id', 'r.key as key'])
      .where('mr.membership_id', '=', membershipId)
      .execute();
    const perms = roles.length
      ? await tx
          .selectFrom('core.role_permission')
          .select('permission_key')
          .where(
            'role_id',
            'in',
            roles.map((r) => r.id),
          )
          .execute()
      : [];
    return buildAuthorizationContext({
      tenantId,
      userId,
      roles: roles.map((r) => r.key),
      permissions: perms.map((p) => p.permission_key),
    });
  }
}
