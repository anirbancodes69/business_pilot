import { NextResponse } from 'next/server';
import { loadConfig } from '../../lib/config';
import { getJar, sameOrigin } from '../../lib/server';
import { clearSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

/** Ends the local session. The identity provider's own session is not ended (see ADR-0020). */
export async function POST(req: Request): Promise<Response> {
  const cfg = loadConfig();
  if (!sameOrigin(req, cfg)) return new NextResponse(null, { status: 403 });
  clearSession(await getJar());
  return NextResponse.redirect(`${cfg.baseUrl}/`, 303);
}
