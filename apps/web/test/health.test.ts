import { describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/health/route';

describe('web health route', () => {
  it('returns ok', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
