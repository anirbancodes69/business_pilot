// Object storage port (ADR-0015). Product code depends on this interface only. Adapters: `dummy`
// (in memory) and `local` (a directory on a shared volume, ADR-0016). The S3-compatible product for
// hosted deployments is not chosen yet (D-OPEN-24).

export interface ObjectStorage {
  /** True for a stand-in that keeps nothing durable. Callers must not treat the data as stored. */
  readonly isDummy: boolean;
  put(tenantId: string, key: string, body: Buffer): Promise<void>;
  get(tenantId: string, key: string): Promise<Buffer | undefined>;
  delete(tenantId: string, key: string): Promise<void>;
}

export const OBJECT_STORAGE_TOKEN = Symbol('OBJECT_STORAGE');

/**
 * Every object lives under `tenants/{tenant_id}/` (SECURITY.md). The key is validated here, so no
 * adapter can be handed a path that escapes the tenant prefix.
 */
export function tenantObjectKey(tenantId: string, key: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('invalid tenant id');
  const segments = key.split('/');
  if (
    key === '' ||
    key.length > 512 ||
    key.startsWith('/') ||
    segments.some((s) => s === '' || s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s))
  )
    throw new Error('invalid object key');
  return `tenants/${tenantId.toLowerCase()}/${key}`;
}
