import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { type ObjectStorage, tenantObjectKey } from './object-storage';

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

/**
 * Object storage on a local directory (ADR-0016). In Docker Compose the directory is a named volume
 * mounted into both the api and the worker, so both processes see the same files and a restart keeps
 * them. It works on one machine only: a hosted deployment needs the S3-compatible adapter (D-OPEN-24).
 * Files are written as given. There is no encryption at rest beyond what the disk provides.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly isDummy = false;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(tenantId: string, key: string): string {
    // tenantObjectKey validates both parts; the prefix check is a second line of defence.
    const path = join(this.root, ...tenantObjectKey(tenantId, key).split('/'));
    if (!path.startsWith(this.root + sep)) throw new Error('invalid object key');
    return path;
  }

  async put(tenantId: string, key: string, body: Buffer): Promise<void> {
    const path = this.path(tenantId, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Write beside the target and rename, so a reader never sees a half-written file.
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async get(tenantId: string, key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(tenantId, key));
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async delete(tenantId: string, key: string): Promise<void> {
    await rm(this.path(tenantId, key), { force: true });
  }
}
