import { NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import { callApi, freshSession, sameOrigin } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed messages only: nothing from the api's or the model's error bodies reaches the browser. */
const ERRORS: Record<number, [number, string]> = {
  401: [401, 'session_expired'],
  403: [403, 'not_allowed'],
  404: [404, 'not_found'],
  429: [429, 'rate_limited'],
  503: [503, 'unavailable'],
};

export async function POST(req: Request): Promise<Response> {
  const cfg = loadConfig();
  if (!sameOrigin(req, cfg)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await freshSession(cfg);
  if (!session) return NextResponse.json({ error: 'session_expired' }, { status: 401 });

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const { question, conversation_id: conversationId } = (input ?? {}) as Record<string, unknown>;
  if (typeof question !== 'string' || !question.trim() || question.length > 1000)
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  if (
    conversationId !== undefined &&
    (typeof conversationId !== 'string' || !UUID.test(conversationId))
  )
    return NextResponse.json({ error: 'invalid' }, { status: 400 });

  let res: Response;
  try {
    res = await callApi(cfg, session, '/v1/questions', {
      method: 'POST',
      body: { question: question.trim(), conversation_id: conversationId },
      timeoutMs: 90_000,
    });
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (!res.ok) {
    // One 403 has its own message: the workspace has not agreed to AI processing yet (ADR-0022).
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      if (body.message === 'ai_processing_disabled')
        return NextResponse.json({ error: 'ai_disabled' }, { status: 403 });
    }
    const [status, error] = ERRORS[res.status] ?? [502, 'failed'];
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json(await res.json());
}
