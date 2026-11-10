import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthModule } from '../src/health/health.module';
import { runChecks } from '../src/health/health.service';
import { AiEngineClient } from '../src/platform/ai-engine/ai-engine.client';
import { DatabaseService } from '../src/platform/database/database.module';
import { requestIdMiddleware } from '../src/platform/request-id/request-id';

describe('runChecks', () => {
  it('reports failure without leaking error text', async () => {
    const r = await runChecks({
      a: async () => undefined,
      b: async () => {
        throw new Error('postgres://user:pw@host');
      },
    });
    expect(r).toEqual({ status: 'fail', checks: { a: 'ok', b: 'fail' } });
  });
});

describe('health endpoints', () => {
  let app: INestApplication;
  let dbOk = true;
  let base = '';

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [HealthModule] })
      .useMocker((token) => {
        if (token === DatabaseService)
          return { ping: async () => (dbOk ? undefined : Promise.reject(new Error('down'))) };
        if (token === AiEngineClient) return { health: async () => undefined };
        return {};
      })
      .compile();
    app = mod.createNestApplication();
    app.use(requestIdMiddleware);
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app.close());

  it('live is ok and echoes a request id', async () => {
    const res = await fetch(`${base}/health/live`, { headers: { 'x-request-id': 'req-12345678' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-12345678');
  });
  it('ready is 200 when dependencies are up, 503 when not', async () => {
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    dbOk = false;
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'fail',
      checks: { postgres: 'fail', aiEngine: 'ok' },
    });
  });
});
