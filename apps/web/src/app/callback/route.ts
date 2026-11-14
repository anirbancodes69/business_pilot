import { NextResponse } from 'next/server';
import { loadConfig } from '../../lib/config';
import { exchangeCode } from '../../lib/oidc';
import { callApi, getJar, isSecure } from '../../lib/server';
import { LOGIN_COOKIE, type Session, unseal, writeSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface Me {
  memberships?: { tenant_id: string; status: string; name: string | null }[];
}

export async function GET(req: Request): Promise<Response> {
  const fail = (reason: string, base?: string) =>
    NextResponse.redirect(new URL(`/?error=${reason}`, base ?? req.url), 303);
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return fail('config');
  }
  const to = (reason: string) => NextResponse.redirect(`${cfg.baseUrl}/?error=${reason}`, 303);
  const jar = await getJar();
  const pending = jar.get(LOGIN_COOKIE)?.value;
  jar.delete(LOGIN_COOKIE);
  const login = pending
    ? unseal<{ verifier: string; state: string }>(pending, cfg.sessionSecret)
    : undefined;
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (!login || !code || url.searchParams.get('state') !== login.state) return to('signin');

  const tokens = await exchangeCode(cfg, code, login.verifier);
  if (!tokens) return to('signin');

  // The api is the authority on memberships. Use the first active one (a picker comes later).
  const probe: Session = { ...tokens, tenantId: '', tenantName: null };
  const me = await callApi(cfg, probe, '/v1/me', { tenant: false });
  if (!me.ok) return to('signin');
  const active = ((await me.json()) as Me).memberships?.find((m) => m.status === 'active');
  if (!active) return to('no-workspace');

  writeSession(
    jar,
    { ...tokens, tenantId: active.tenant_id, tenantName: active.name },
    cfg.sessionSecret,
    isSecure(cfg),
  );
  return NextResponse.redirect(`${cfg.baseUrl}/`, 303);
}
