import { NextResponse } from 'next/server';
import { loadConfig } from '../../../../lib/config';
import { callApi, freshSession, sameOrigin } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function forward(id: string, method: 'GET' | 'DELETE'): Promise<Response> {
  const cfg = loadConfig();
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const session = await freshSession(cfg);
  if (!session) return NextResponse.json({ error: 'session_expired' }, { status: 401 });
  try {
    const res = await callApi(cfg, session, `/v1/conversations/${id}`, { method });
    if (res.status === 404) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (!res.ok)
      return NextResponse.json({ error: 'failed' }, { status: res.status === 401 ? 401 : 502 });
    return method === 'DELETE'
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return forward((await ctx.params).id, 'GET');
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!sameOrigin(req, loadConfig()))
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return forward((await ctx.params).id, 'DELETE');
}
