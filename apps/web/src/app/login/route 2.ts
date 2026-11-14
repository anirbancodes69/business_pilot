import { NextResponse } from 'next/server';
import { loadConfig } from '../../lib/config';
import { authorizeUrl, newPkce } from '../../lib/oidc';
import { getJar, isSecure } from '../../lib/server';
import { LOGIN_COOKIE, cookieOptions, seal } from '../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return NextResponse.redirect(new URL('/?error=config', 'http://localhost'), 303);
  }
  const pkce = newPkce();
  (await getJar()).set(
    LOGIN_COOKIE,
    seal({ verifier: pkce.verifier, state: pkce.state }, cfg.sessionSecret),
    cookieOptions(isSecure(cfg), 600),
  );
  return NextResponse.redirect(authorizeUrl(cfg, pkce.state, pkce.challenge), 303);
}
