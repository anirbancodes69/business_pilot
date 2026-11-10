import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/platform/config/env';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ POSTGRES_APP_PASSWORD: 'x' });
    expect(env.API_PORT).toBe(3001);
    expect(env.POSTGRES_APP_USER).toBe('bp_app');
  });
  it('fails with variable names only, never values', () => {
    expect(() => loadEnv({ API_PORT: 'secret-value' })).toThrow(/API_PORT, POSTGRES_APP_PASSWORD/);
    expect(() => loadEnv({ API_PORT: 'secret-value' })).not.toThrow(/secret-value/);
  });
});
