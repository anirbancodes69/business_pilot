import { cookies } from 'next/headers';
import { type WebConfig, loadConfig } from './config';
import { refreshTokens } from './oidc';
export { sameOrigin } from './origin';
import { type CookieJar, type Session, readSession, writeSession } from './session';

// Server-only helpers for route handlers and server components.

export const isSecure = (cfg: WebConfig): boolean => cfg.baseUrl.startsWith('https://');

export async function getJar(): Promise<CookieJar> {
  return (await cookies()) as unknown as CookieJar;
}

export async function currentSession(): Promise<Session | undefined> {
  return readSession(await getJar(), loadConfig().sessionSecret);
}

/**
 * Returns a session whose access token is valid for at least 30 more seconds, refreshing it (and the
 * cookie) when needed. Only route handlers can set cookies, so call this from route handlers.
 */
export async function freshSession(cfg: WebConfig): Promise<Session | undefined> {
  const jar = await getJar();
  const session = readSession(jar, cfg.sessionSecret);
  if (!session) return undefined;
  if (session.expiresAt - Date.now() > 30_000) return session;
  const tokens = await refreshTokens(cfg, session.refreshToken);
  if (!tokens) return undefined;
  const next = { ...session, ...tokens };
  writeSession(jar, next, cfg.sessionSecret, isSecure(cfg));
  return next;
}

export async function callApi(
  cfg: WebConfig,
  session: Session,
  path: string,
  init: { method?: string; body?: unknown; tenant?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
  if (init.tenant !== false) headers['x-tenant-id'] = session.tenantId;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${cfg.apiBaseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    cache: 'no-store',
  });
}
