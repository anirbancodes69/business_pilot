import { type ObjectStorage, tenantObjectKey } from './object-storage';

/**
 * In-memory stand-in for object storage (ADR-0015). Nothing is durable and nothing is shared between
 * processes: the api and the worker each see their own copy, and a restart loses everything.
 * It exists so upload flows can be built and tested before the storage product is chosen.
 */
export class DummyObjectStorage implements ObjectStorage {
  readonly isDummy = true;
  private readonly objects = new Map<string, Buffer>();

  put(tenantId: string, key: string, body: Buffer): Promise<void> {
    this.objects.set(tenantObjectKey(tenantId, key), Buffer.from(body));
    return Promise.resolve();
  }

  get(tenantId: string, key: string): Promise<Buffer | undefined> {
    const found = this.objects.get(tenantObjectKey(tenantId, key));
    return Promise.resolve(found ? Buffer.from(found) : undefined);
  }

  delete(tenantId: string, key: string): Promise<void> {
    this.objects.delete(tenantObjectKey(tenantId, key));
    return Promise.resolve();
  }
}
