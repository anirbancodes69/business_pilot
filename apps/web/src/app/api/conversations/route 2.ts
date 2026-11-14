import { NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import { callApi, freshSession } from '../../../lib/server';

export const dynamic = 'force-dynamic';

/** The signed-in user's conversations, for the sidebar. Fixed errors only. */
export async function GET(): Promise<Response> {
  const cfg = loadConfig();
  const session = await freshSession(cfg);
  if (!session) return NextResponse.json({ error: 'session_expired' }, { status: 401 });
  try {
    const res = await callApi(cfg, session, '/v1/conversations');
    if (!res.ok)
      return NextResponse.json({ error: 'failed' }, { status: res.status === 401 ? 401 : 502 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
