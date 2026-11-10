import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { trace } from '@opentelemetry/api';

export const REQUEST_ID_HEADER = 'x-request-id';

// request_id is a correlation identifier only. It is never used for authorization.
// Inbound values are accepted only if they look like a UUID or a short safe token.
const SAFE = /^[A-Za-z0-9._-]{8,64}$/;

export function resolveRequestId(inbound: string | string[] | undefined): string {
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return value !== undefined && SAFE.test(value) ? value : randomUUID();
}

const store = new AsyncLocalStorage<string>();

export function currentRequestId(): string | undefined {
  return store.getStore();
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return store.run(requestId, fn);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  trace.getActiveSpan()?.setAttribute('request_id', requestId);
  runWithRequestId(requestId, next);
}
