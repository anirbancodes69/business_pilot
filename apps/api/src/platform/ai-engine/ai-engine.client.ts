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

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.baseUrl = env.AI_ENGINE_BASE_URL.replace(/\/$/, '');
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
