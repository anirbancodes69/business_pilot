import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionGuard } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import { IdentityService } from '../identity/identity.service';
import { OidcTokenVerifier, TokenVerifier } from '../identity/token-verifier';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';

@Module({
  controllers: [TenancyController],
  providers: [
    AuditService,
    AuthorizationService,
    IdentityService,
    TenancyService,
    AuthGuard,
    TenantGuard,
    PermissionGuard,
    {
      provide: TokenVerifier,
      inject: [Env_TOKEN],
      useFactory: (env: Env) => new OidcTokenVerifier(env.OIDC_ISSUER_URL, env.OIDC_CLIENT_ID),
    },
  ],
  exports: [
    TenancyService,
    IdentityService,
    AuditService,
    AuthorizationService,
    TokenVerifier,
    AuthGuard,
    TenantGuard,
    PermissionGuard,
  ],
})
export class TenancyModule {}
