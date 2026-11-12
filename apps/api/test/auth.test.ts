import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { OidcTokenVerifier, UnauthenticatedError } from '../src/identity/token-verifier';
import { ServiceTokenGuard } from '../src/platform/service-auth/service-token.guard';
import { loadEnv } from '../src/platform/config/env';

const ISSUER = 'https://idp.example.test';
const AUD = 'businesspilot';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = (
    claims: Record<string, unknown>,
    o: { iss?: string; aud?: string; exp?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? AUD)
      .setExpirationTime(o.exp ?? '5m')
      .sign(privateKey);
  return { sign, verifier: new OidcTokenVerifier(ISSUER, AUD, createLocalJWKSet({ keys: [jwk] })) };
}

describe('OIDC token verification', () => {
  it('accepts a valid token and returns identity only', async () => {
    const { sign, verifier } = await setup();
    const id = await verifier.verify(
      await sign({
        sub: 'user-1',
        email: 'a@x.test',
        name: 'A',
        tenant_id: 'evil',
        roles: ['owner'],
      }),
    );
    expect(id).toEqual({ subject: 'user-1', email: 'a@x.test', name: 'A' }); // tenant/role claims are ignored
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['wrong audience', { aud: 'other' }],
    ['expired', { exp: '-1m' }],
  ])('rejects %s', async (_n, o) => {
    const { sign, verifier } = await setup();
    await expect(verifier.verify(await sign({ sub: 'u' }, o))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects a token without sub and an unsigned/garbage token', async () => {
    const { sign, verifier } = await setup();
    await expect(verifier.verify(await sign({}))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(verifier.verify('not.a.jwt')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('fails closed when authentication is not configured', async () => {
    await expect(new OidcTokenVerifier(undefined, undefined).verify('x')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('service token guard', () => {
  const ctx = (authorization?: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) }) as never;
  const guard = (token?: string) =>
    new ServiceTokenGuard(loadEnv({ POSTGRES_APP_PASSWORD: 'x', INTERNAL_SERVICE_TOKEN: token }));

  it('accepts the configured token, including a rotation overlap list', () => {
    const g = guard('a'.repeat(20) + ',' + 'b'.repeat(20));
    expect(g.canActivate(ctx('Bearer ' + 'a'.repeat(20)))).toBe(true);
    expect(g.canActivate(ctx('Bearer ' + 'b'.repeat(20)))).toBe(true);
  });
  it('rejects wrong, missing and any token when none is configured', () => {
    expect(() => guard('a'.repeat(20)).canActivate(ctx('Bearer nope'))).toThrow();
    expect(() => guard('a'.repeat(20)).canActivate(ctx(undefined))).toThrow();
    expect(() => guard(undefined).canActivate(ctx('Bearer '))).toThrow();
  });
});
