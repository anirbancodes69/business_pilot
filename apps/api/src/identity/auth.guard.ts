import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service';
import { DatabaseService } from '../platform/database/database.module';
import { assertUuid } from '../platform/database/tenant-tx';
import type { AuthedRequest } from './auth.types';
import { IdentityService } from './identity.service';
import { TokenVerifier, UnauthenticatedError } from './token-verifier';

/** Step 1: authenticate the bearer token and resolve the app user. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const identity = await this.verifier.verify(header.slice(7));
      const user = await this.identity.resolveUser(identity);
      if (!user) throw new UnauthenticatedError('disabled');
      req.user = user;
      return true;
    } catch (err) {
      if (err instanceof UnauthenticatedError) throw new UnauthorizedException();
      throw err;
    }
  }
}

/**
 * Step 2 (tenant routes): the client may only *select* an active tenant with X-Tenant-Id. The selection is
 * accepted only if the authenticated user has an active membership there. Roles and scope are then
 * computed server-side. Unknown tenants and foreign tenants are indistinguishable (both 403).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException();
    const selected = req.headers['x-tenant-id'];
    if (typeof selected !== 'string') throw new ForbiddenException();
    try {
      assertUuid(selected, 'tenant');
    } catch {
      throw new ForbiddenException();
    }
    const userId = req.user.id;
    const membership = await this.db.userTx(userId, (tx) =>
      tx
        .selectFrom('core.tenant_membership')
        .select(['id', 'status'])
        .where('tenant_id', '=', selected)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (!membership || membership.status !== 'active') throw new ForbiddenException();
    const authz = await this.db.tenantTx(selected, async (tx) => {
      const tenant = await tx
        .selectFrom('core.tenant')
        .select('status')
        .where('id', '=', selected)
        .executeTakeFirst();
      if (tenant?.status !== 'active') return null;
      return this.authz.load(tx, selected, userId, membership.id);
    });
    if (!authz) throw new ForbiddenException();
    req.auth = { userId, tenantId: selected, membershipId: membership.id, authz };
    return true;
  }
}
