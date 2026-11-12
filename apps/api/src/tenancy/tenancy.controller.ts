import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import type { AuthedRequest } from '../identity/auth.types';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import { IdentityService } from '../identity/identity.service';
import { DatabaseService } from '../platform/database/database.module';
import { assertUuid } from '../platform/database/tenant-tx';

const rolesBody = z.strictObject({ roles: z.array(z.string().min(1)).min(1).max(10) });

function uuidParam(value: string): string {
  try {
    return assertUuid(value, 'id');
  } catch {
    throw new NotFoundException();
  }
}

@Controller('v1')
export class TenancyController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The caller's own memberships, to choose an active tenant. No tenant header needed. */
  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() req: AuthedRequest) {
    const userId = (req.user as { id: string }).id;
    const memberships = await this.identity.listMemberships(userId);
    const tenants = await Promise.all(
      memberships.map(async (m) => ({
        membership_id: m.id,
        tenant_id: m.tenant_id,
        status: m.status,
        name: await this.db.tenantTx(
          m.tenant_id,
          async (tx) =>
            (
              await tx
                .selectFrom('core.tenant')
                .select('name')
                .where('id', '=', m.tenant_id)
                .executeTakeFirst()
            )?.name ?? null,
        ),
      })),
    );
    return { user_id: userId, memberships: tenants };
  }

  @Get('tenant')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission('tenant:read')
  async tenant(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.tenant')
        .select(['id', 'name', 'slug', 'status'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow(),
    );
  }

  @Get('memberships')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission('user:read')
  async listMemberships(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.tenant_membership as m')
        .innerJoin('core.app_user as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.status', 'u.display_name', 'u.email'])
        .where('m.tenant_id', '=', tenantId)
        .execute(),
    );
  }

  @Get('memberships/:id')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission('user:read')
  async getMembership(@Req() req: AuthedRequest, @Param('id') idParam: string) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const id = uuidParam(idParam);
    const row = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.tenant_membership')
        .select(['id', 'status', 'attributes'])
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Put('memberships/:id/roles')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission('user:manage')
  async setRoles(@Req() req: AuthedRequest, @Param('id') idParam: string, @Body() body: unknown) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const id = uuidParam(idParam);
    const parsed = rolesBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('roles must be a non-empty list of role keys');
    const wanted = [...new Set(parsed.data.roles)];

    return this.db.tenantTx(tenantId, async (tx) => {
      const membership = await tx
        .selectFrom('core.tenant_membership')
        .select('id')
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!membership) throw new NotFoundException();

      // RLS limits visible roles to system roles and this tenant's own roles.
      const roles = await tx
        .selectFrom('core.role')
        .select(['id', 'key'])
        .where('key', 'in', wanted)
        .execute();
      if (roles.length !== wanted.length) throw new BadRequestException('unknown role');

      const before = await tx
        .selectFrom('core.membership_role as mr')
        .innerJoin('core.role as r', 'r.id', 'mr.role_id')
        .select('r.key as key')
        .where('mr.membership_id', '=', id)
        .execute();
      const beforeKeys = before.map((r) => r.key).sort();

      if (beforeKeys.includes('owner') && !wanted.includes('owner')) {
        const owners = await tx
          .selectFrom('core.membership_role as mr')
          .innerJoin('core.role as r', 'r.id', 'mr.role_id')
          .select('mr.membership_id')
          .where('r.key', '=', 'owner')
          .where('mr.membership_id', '!=', id)
          .execute();
        if (owners.length === 0)
          throw new ConflictException('a tenant must keep at least one owner');
      }

      await tx.deleteFrom('core.membership_role').where('membership_id', '=', id).execute();
      await tx
        .insertInto('core.membership_role')
        .values(roles.map((r) => ({ tenant_id: tenantId, membership_id: id, role_id: r.id })))
        .execute();
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'membership.roles_changed',
        target: id,
        metadata: { before: beforeKeys, after: [...wanted].sort() },
      });
      return { id, roles: [...wanted].sort() };
    });
  }

  @Get('audit-events')
  @UseGuards(AuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission('audit:read')
  async auditEvents(@Req() req: AuthedRequest) {
    const { tenantId } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['id', 'actor_id', 'action', 'target', 'metadata', 'occurred_at'])
        .where('tenant_id', '=', tenantId)
        .orderBy('occurred_at', 'desc')
        .limit(100)
        .execute(),
    );
  }
}
