import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  return {
    sign,
    jwk,
    verifier: new OidcTokenVerifier(ISSUER, AUD, createLocalJWKSet({ keys: [jwk] })),
  };
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

  it('reads keys from OIDC_JWKS_URL without discovery and still checks the issuer', async () => {
    const { sign, jwk } = await setup();
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as AddressInfo).port;
      // The issuer is not reachable from here; only the key URL is.
      const verifier = new OidcTokenVerifier(
        ISSUER,
        AUD,
        undefined,
        `http://127.0.0.1:${port}/certs`,
      );
      expect((await verifier.verify(await sign({ sub: 'user-1' }))).subject).toBe('user-1');
      await expect(
        verifier.verify(await sign({ sub: 'user-1' }, { iss: 'https://evil.test' })),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
      expect(new Set(paths)).toEqual(new Set(['/certs']));
    } finally {
      await new Promise((done) => server.close(done));
    }
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
