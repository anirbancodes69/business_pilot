import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ENVELOPE_TOKEN } from '../platform/crypto/crypto.module';
import type { EnvelopeCrypto } from '../platform/crypto/envelope';
import { DatabaseService } from '../platform/database/database.module';

@Injectable()
export class TenancyService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENVELOPE_TOKEN) private readonly crypto: EnvelopeCrypto | null,
  ) {}

  /**
   * Creates a tenant, its per-tenant data key, the owner membership and the owner role in one
   * transaction under the new tenant's own context (no RLS bypass is involved).
   * Not exposed over HTTP yet: self-service sign-up and invitations are a later milestone.
   */
  async provision(input: {
    name: string;
    slug: string;
    ownerUserId: string;
    templateId?: string;
  }): Promise<string> {
    if (!this.crypto) throw new Error('Key management is not configured');
    const tenantId = randomUUID();
    const key = this.crypto.newTenantKey(tenantId);
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx
        .insertInto('core.tenant')
        .values({
          id: tenantId,
          name: input.name,
          slug: input.slug,
          status: 'provisioning',
          region: null,
          plan: null,
          template_id: input.templateId ?? null,
          key_id: key.keyId,
          wrapped_data_key: key.wrappedDataKey,
        })
        .execute();
      const membership = await tx
        .insertInto('core.tenant_membership')
        .values({
          tenant_id: tenantId,
          user_id: input.ownerUserId,
          status: 'active',
          attributes: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const owner = await tx
        .selectFrom('core.role')
        .select('id')
        .where('key', '=', 'owner')
        .where('tenant_id', 'is', null)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('core.membership_role')
        .values({ tenant_id: tenantId, membership_id: membership.id, role_id: owner.id })
        .execute();
      await tx
        .updateTable('core.tenant')
        .set({ status: 'active' })
        .where('id', '=', tenantId)
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: input.ownerUserId,
        action: 'tenant.provisioned',
        target: tenantId,
      });
    });
    return tenantId;
  }
}
