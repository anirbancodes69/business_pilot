import { Inject, Injectable } from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { currentRequestId, REQUEST_ID_HEADER } from '../request-id/request-id';

const tracer = trace.getTracer('bp-api');

/** The only way the api talks to the ai-engine. Propagates trace context and request_id. */
@Injectable()
export class AiEngineClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.baseUrl = env.AI_ENGINE_BASE_URL.replace(/\/$/, '');
    // The first configured token is the one this service presents to ai-engine.
    this.serviceToken = (env.INTERNAL_SERVICE_TOKEN ?? '').split(',')[0]?.trim() ?? '';
  }

  /** POST /internal/v1/answer. Throws a fixed-text error: the body is never copied into it. */
  async answer(body: unknown, requestId: string): Promise<unknown> {
    if (!this.serviceToken) throw new Error('ai-engine is not configured');
    return tracer.startActiveSpan('ai-engine.answer', async (span) => {
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          authorization: `Bearer ${this.serviceToken}`,
          [REQUEST_ID_HEADER]: requestId,
        };
        propagation.inject(context.active(), headers);
        span.setAttribute('request_id', requestId);
        const res = await fetch(`${this.baseUrl}/internal/v1/answer`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`ai-engine answer returned ${res.status}`);
        return (await res.json()) as unknown;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async health(): Promise<void> {
    await tracer.startActiveSpan('ai-engine.health', async (span) => {
      try {
        const headers: Record<string, string> = {};
        propagation.inject(context.active(), headers); // traceparent
        const requestId = currentRequestId();
        if (requestId) {
          headers[REQUEST_ID_HEADER] = requestId;
          span.setAttribute('request_id', requestId);
        }
        const res = await fetch(`${this.baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`ai-engine health returned ${res.status}`);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
