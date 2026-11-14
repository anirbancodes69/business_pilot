import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DummyObjectStorage } from '../src/platform/object-storage/dummy-object-storage';
import { LocalObjectStorage } from '../src/platform/object-storage/local-object-storage';
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

describe('local directory adapter', () => {
  const a = randomUUID();
  const b = randomUUID();
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bp-objects-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is not a stand-in', () => {
    expect(new LocalObjectStorage(root).isDummy).toBe(false);
  });

  it('stores, overwrites, reads and deletes under the tenant prefix', async () => {
    const store = new LocalObjectStorage(root);
    await store.put(a, 'uploads/f1.xlsx', Buffer.from('first'));
    await store.put(a, 'uploads/f1.xlsx', Buffer.from('second'));
    expect((await store.get(a, 'uploads/f1.xlsx'))?.toString()).toBe('second');
    expect((await readFile(join(root, 'tenants', a, 'uploads', 'f1.xlsx'))).toString()).toBe(
      'second',
    );
    // no temporary file is left behind
    expect(await readdir(join(root, 'tenants', a, 'uploads'))).toEqual(['f1.xlsx']);
    await store.delete(a, 'uploads/f1.xlsx');
    expect(await store.get(a, 'uploads/f1.xlsx')).toBeUndefined();
    await store.delete(a, 'uploads/f1.xlsx'); // deleting a missing object is not an error
  });

  it('is shared by two instances on the same directory, as the api and the worker are', async () => {
    await new LocalObjectStorage(root).put(a, 'uploads/shared.xlsx', Buffer.from('from api'));
    const worker = new LocalObjectStorage(root);
    expect((await worker.get(a, 'uploads/shared.xlsx'))?.toString()).toBe('from api');
  });

  it("never returns or deletes another tenant's object for the same key", async () => {
    const store = new LocalObjectStorage(root);
    await store.put(a, 'uploads/f2.xlsx', Buffer.from('tenant A'));
    await store.put(b, 'uploads/f3.xlsx', Buffer.from('tenant B'));
    expect(await store.get(b, 'uploads/f2.xlsx')).toBeUndefined();
    await store.delete(b, 'uploads/f2.xlsx');
    expect((await store.get(a, 'uploads/f2.xlsx'))?.toString()).toBe('tenant A');
    expect(await store.get(a, 'uploads/f3.xlsx')).toBeUndefined();
  });

  it('refuses keys and tenant ids that would leave the tenant directory', async () => {
    const store = new LocalObjectStorage(root);
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\..\\b', ''])
      await expect(store.put(a, bad, Buffer.from('x')), bad).rejects.toThrow('invalid object key');
    await expect(store.get('../..', 'k')).rejects.toThrow('invalid tenant id');
    await expect(store.delete(`${a}/../${b}`, 'k')).rejects.toThrow('invalid tenant id');
    expect((await readdir(root)).sort()).toEqual(['tenants']);
  });
});
