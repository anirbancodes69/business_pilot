import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthedRequest } from '../identity/auth.types';
import { hasPermission } from './authorization';

const KEY = 'required_permission';
export const RequirePermission = (permission: string): MethodDecorator =>
  SetMetadata(KEY, permission);

/** Default deny: a tenant route without @RequirePermission is rejected. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.get<string | undefined>(KEY, context.getHandler());
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!permission || !auth || !hasPermission(auth.authz, permission))
      throw new ForbiddenException();
    return true;
  }
}
