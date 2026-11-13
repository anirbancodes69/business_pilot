import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DummyObjectStorage } from '../src/platform/object-storage/dummy-object-storage';
import { tenantObjectKey } from '../src/platform/object-storage/object-storage';

describe('object storage port and dummy adapter', () => {
  const a = randomUUID();
  const b = randomUUID();

  it('is marked as a stand-in', () => {
    expect(new DummyObjectStorage().isDummy).toBe(true);
  });

  it('stores, reads and deletes, and copies the bytes', async () => {
    const store = new DummyObjectStorage();
    const body = Buffer.from('hello');
    await store.put(a, 'uploads/f1.xlsx', body);
    body.write('J');
    expect((await store.get(a, 'uploads/f1.xlsx'))?.toString()).toBe('hello');
    await store.delete(a, 'uploads/f1.xlsx');
    expect(await store.get(a, 'uploads/f1.xlsx')).toBeUndefined();
  });

  it("never returns another tenant's object for the same key", async () => {
    const store = new DummyObjectStorage();
    await store.put(a, 'uploads/f1.xlsx', Buffer.from('tenant A'));
    expect(await store.get(b, 'uploads/f1.xlsx')).toBeUndefined();
    await store.delete(b, 'uploads/f1.xlsx');
    expect((await store.get(a, 'uploads/f1.xlsx'))?.toString()).toBe('tenant A');
  });

  it('puts every key under the tenant prefix and refuses keys that escape it', () => {
    expect(tenantObjectKey(a, 'uploads/f1.xlsx')).toBe(`tenants/${a}/uploads/f1.xlsx`);
    for (const bad of [
      '',
      '/abs',
      '../x',
      'a/../b',
      'a//b',
      'a/./b',
      'a b',
      'a\\b',
      'x'.repeat(513),
    ])
      expect(() => tenantObjectKey(a, bad), bad).toThrow('invalid object key');
    expect(() => tenantObjectKey('not-a-uuid', 'k')).toThrow('invalid tenant id');
    expect(() => tenantObjectKey('../..', 'k')).toThrow('invalid tenant id');
  });
});
