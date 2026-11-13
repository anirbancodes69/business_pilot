import { Injectable } from '@nestjs/common';
import type { Tx } from '../platform/database/tenant-tx';
import { type AuthorizationContext, buildAuthorizationContext } from './authorization';
import { validateAccessPolicy } from './access-policy.validator';
import { evaluatePolicy } from './policy-evaluator';
import { validateSemanticModel } from '../configuration/semantic-model.validator';

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
    const roleKeys = roles.map((r) => r.key);
    const permissions = perms.map((p) => p.permission_key);
    let rowFilters: AuthorizationContext['row_filters'] = [];
    let columnMasks: AuthorizationContext['column_masks'] = [];
    let policyVersion = 1;

    // Data grants come only from the active access policy evaluated against the published
    // semantic model. Without either, the user has no data grants (default deny).
    const [policyRow, modelRow, membership] = await Promise.all([
      tx
        .selectFrom('core.access_policy')
        .select(['version', 'document'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
      tx
        .selectFrom('core.semantic_model')
        .select('document')
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .executeTakeFirst(),
      tx
        .selectFrom('core.tenant_membership')
        .select('attributes')
        .where('id', '=', membershipId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    ]);
    if (policyRow && modelRow) {
      const { policy } = validateAccessPolicy(policyRow.document);
      const { document: model } = validateSemanticModel(modelRow.document);
      if (policy && model) {
        const effect = evaluatePolicy({
          policy,
          model,
          roles: roleKeys,
          userId,
          attributes: membership?.attributes ?? {},
        });
        permissions.push(...effect.permissions);
        rowFilters = effect.rowFilters;
        columnMasks = effect.columnMasks;
        policyVersion = policyRow.version;
      }
    }
    return buildAuthorizationContext({
      tenantId,
      userId,
      roles: roleKeys,
      permissions,
      rowFilters,
      columnMasks,
      policyVersion,
    });
  }
}
