import { describe, expect, it } from 'vitest';
import {
  RequestContextError,
  RequestContextSigner,
} from '../src/platform/service-auth/request-context';

const KEY = 'k'.repeat(40);
const OLD = 'o'.repeat(40);
const claims = {
  request_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  user_id: '33333333-3333-4333-8333-333333333333',
  authz_scope_hash: 'a'.repeat(64),
  semantic_model_version: 3,
};

describe('RequestContext signing', () => {
  it('round-trips valid claims', () => {
    const s = new RequestContextSigner([KEY]);
    const out = s.verify(s.issue(claims), claims.request_id);
    expect(out.tenant_id).toBe(claims.tenant_id);
  });

  it('rejects a tampered payload (TI-10)', () => {
    const s = new RequestContextSigner([KEY]);
    const [payload, sig] = s.issue(claims).split('.') as [string, string];
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    forged.tenant_id = '99999999-9999-4999-8999-999999999999';
    const token = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect(() => s.verify(token, claims.request_id)).toThrow(RequestContextError);
  });

  it('rejects a token signed with another key', () => {
    const token = new RequestContextSigner([OLD]).issue(claims);
    expect(() => new RequestContextSigner([KEY]).verify(token, claims.request_id)).toThrow(
      'bad signature',
    );
  });

  it('rejects an expired token', () => {
    let now = new Date('2026-11-13T10:00:00Z');
    const s = new RequestContextSigner([KEY], () => now);
    const token = s.issue(claims, 120);
    now = new Date('2026-11-13T10:02:01Z');
    expect(() => s.verify(token, claims.request_id)).toThrow('expired');
  });

  it('rejects replay against a different request_id (TI-10)', () => {
    const s = new RequestContextSigner([KEY]);
    expect(() => s.verify(s.issue(claims), '44444444-4444-4444-8444-444444444444')).toThrow(
      'request_id mismatch',
    );
  });

  it('accepts tokens signed with a previous key during rotation, and signs with the new one', () => {
    const oldToken = new RequestContextSigner([OLD]).issue(claims);
    const rotated = new RequestContextSigner([KEY, OLD]);
    expect(rotated.verify(oldToken, claims.request_id).user_id).toBe(claims.user_id);
    expect(() =>
      new RequestContextSigner([OLD]).verify(rotated.issue(claims), claims.request_id),
    ).toThrow();
  });

  it('rejects malformed tokens and weak keys', () => {
    const s = new RequestContextSigner([KEY]);
    for (const bad of ['', 'abc', 'a.b.c', '.'])
      expect(() => s.verify(bad, claims.request_id)).toThrow(RequestContextError);
    expect(() => new RequestContextSigner(['short'])).toThrow();
  });
});
