import { describe, expect, it } from 'vitest';
import {
  currentRequestId,
  resolveRequestId,
  runWithRequestId,
} from '../src/platform/request-id/request-id';

describe('request id', () => {
  it('keeps a well-formed inbound id', () => {
    expect(resolveRequestId('3f2b8c1e-0000-4000-8000-123456789abc')).toBe(
      '3f2b8c1e-0000-4000-8000-123456789abc',
    );
  });
  it.each(['', 'short', 'has spaces in it!', 'x'.repeat(65), '<script>alert(1)</script>'])(
    'replaces malformed inbound id %j',
    (bad) => {
      const id = resolveRequestId(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
  it('generates an id when none is sent', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('exposes the id to async code', async () => {
    await runWithRequestId('abcdefgh-1', async () => {
      await Promise.resolve();
      expect(currentRequestId()).toBe('abcdefgh-1');
    });
  });
});
