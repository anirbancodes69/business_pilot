import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvelopeCrypto } from '../src/platform/crypto/envelope';
import { LocalKeyManagement } from '../src/platform/crypto/key-management';

const kek = () => randomBytes(32).toString('base64');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('envelope encryption', () => {
  const crypto = new EnvelopeCrypto(new LocalKeyManagement(kek()));

  it('round-trips and never stores plaintext', () => {
    const key = crypto.newTenantKey(A);
    const enc = crypto.encrypt(A, key, Buffer.from('db-password'), 'connector_credential');
    expect(enc.ciphertext.includes(Buffer.from('db-password'))).toBe(false);
    expect(crypto.decrypt(A, key, enc, 'connector_credential').toString()).toBe('db-password');
  });

  it('a wrapped key or ciphertext copied to another tenant cannot be used', () => {
    const keyA = crypto.newTenantKey(A);
    const enc = crypto.encrypt(A, keyA, Buffer.from('secret'), 'p');
    expect(() => crypto.decrypt(B, keyA, enc, 'p')).toThrow();
  });

  it('is bound to its purpose and detects tampering', () => {
    const key = crypto.newTenantKey(A);
    const enc = crypto.encrypt(A, key, Buffer.from('secret'), 'p');
    expect(() => crypto.decrypt(A, key, enc, 'other')).toThrow();
    const bad = Buffer.from(enc.ciphertext);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    expect(() => crypto.decrypt(A, key, { ...enc, ciphertext: bad }, 'p')).toThrow();
  });

  it('a different KEK cannot unwrap (crypto-shredding by key loss)', () => {
    const key = crypto.newTenantKey(A);
    const other = new EnvelopeCrypto(new LocalKeyManagement(kek()));
    expect(() => other.encrypt(A, key, Buffer.from('x'), 'p')).toThrow();
  });

  it('rejects a KEK of the wrong size', () => {
    expect(() => new LocalKeyManagement(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});
