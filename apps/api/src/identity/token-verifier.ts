import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  name: string | null;
}

/** Verifies an access token from the external OIDC provider (D-OPEN-03). Claims identify the user only. */
export abstract class TokenVerifier {
  abstract verify(token: string): Promise<VerifiedIdentity>;
}

export class UnauthenticatedError extends Error {}

export class OidcTokenVerifier extends TokenVerifier {
  private keys: JWTVerifyGetKey | undefined;

  constructor(
    private readonly issuer: string | undefined,
    private readonly audience: string | undefined,
    private readonly keySource?: JWTVerifyGetKey, // injectable for tests
  ) {
    super();
  }

  private async getKeys(issuer: string): Promise<JWTVerifyGetKey> {
    if (this.keySource) return this.keySource;
    if (!this.keys) {
      const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5000),
      });
      const doc = (await res.json()) as { jwks_uri?: string };
      if (!res.ok || !doc.jwks_uri) throw new Error('OIDC discovery failed');
      this.keys = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return this.keys;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    // Fail closed when authentication is not configured.
    if (!this.issuer || !this.audience)
      throw new UnauthenticatedError('authentication not configured');
    try {
      const { payload } = await jwtVerify(token, await this.getKeys(this.issuer), {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256', 'ES256', 'PS256', 'EdDSA'],
      });
      if (!payload.sub) throw new Error('missing sub');
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      throw new UnauthenticatedError('invalid token');
    }
  }
}
