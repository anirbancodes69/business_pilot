import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

/** Guards /internal/* endpoints: the caller must present the shared service token (D-OPEN-15, MVP). */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly tokens: Buffer[];

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.tokens = (env.INTERNAL_SERVICE_TOKEN ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length >= 16)
      .map((t) => Buffer.from(t));
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const ok = this.tokens.some((t) => t.length === given.length && timingSafeEqual(t, given));
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}
