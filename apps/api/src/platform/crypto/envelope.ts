import { randomBytes } from 'node:crypto';
import { type KeyManagement, open, seal } from './key-management';

export interface TenantKey {
  keyId: string;
  wrappedDataKey: Buffer;
}

export interface Encrypted {
  keyId: string;
  ciphertext: Buffer;
}

/**
 * Envelope encryption (P-12): a per-tenant data key, wrapped by the KEK in the KeyManagement port.
 * The tenant id is authenticated data for both layers, so ciphertext or a wrapped key copied
 * to another tenant cannot be decrypted. Deleting the wrapped key crypto-shreds the tenant.
 */
export class EnvelopeCrypto {
  constructor(private readonly kms: KeyManagement) {}

  newTenantKey(tenantId: string): TenantKey {
    const dataKey = randomBytes(32);
    return { keyId: this.kms.keyId, wrappedDataKey: this.kms.wrap(dataKey, `tenant:${tenantId}`) };
  }

  encrypt(tenantId: string, key: TenantKey, plaintext: Buffer, purpose: string): Encrypted {
    const dataKey = this.kms.unwrap(key.wrappedDataKey, `tenant:${tenantId}`);
    return { keyId: key.keyId, ciphertext: seal(dataKey, plaintext, `${tenantId}:${purpose}`) };
  }

  decrypt(tenantId: string, key: TenantKey, encrypted: Encrypted, purpose: string): Buffer {
    const dataKey = this.kms.unwrap(key.wrappedDataKey, `tenant:${tenantId}`);
    return open(dataKey, encrypted.ciphertext, `${tenantId}:${purpose}`);
  }
}
