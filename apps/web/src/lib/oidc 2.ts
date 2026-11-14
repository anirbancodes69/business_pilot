import { createHash, randomBytes } from 'node:crypto';
import type { WebConfig } from './config';

// Authorization-code flow with PKCE (ADR-0020). Token calls go server to server.

export function newPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(24).toString('base64url'),
  };
}

export const redirectUri = (cfg: WebConfig): string => `${cfg.baseUrl}/callback`;

export function authorizeUrl(cfg: WebConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${cfg.issuerPublic}/protocol/openid-connect/auth?${q.toString()}`;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function tokenCall(
  cfg: WebConfig,
  form: Record<string, string>,
): Promise<Tokens | undefined> {
  try {
    const res = await fetch(`${cfg.issuerInternal}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, ...form }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const t = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!t.access_token || !t.refresh_token || typeof t.expires_in !== 'number') return undefined;
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
  } catch {
    return undefined;
  }
}

export const exchangeCode = (cfg: WebConfig, code: string, verifier: string) =>
  tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(cfg),
    code_verifier: verifier,
  });

export const refreshTokens = (cfg: WebConfig, refreshToken: string) =>
  tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
