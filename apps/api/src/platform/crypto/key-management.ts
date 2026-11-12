import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * KeyManagement port (P-12). A KEK never leaves this port: callers wrap and unwrap data keys.
 * The local adapter is for development only. Shared environments use a managed KMS adapter.
 */
export interface KeyManagement {
  readonly keyId: string;
  wrap(dataKey: Buffer, context: string): Buffer;
  unwrap(wrapped: Buffer, context: string): Buffer;
}

const IV = 12;
const TAG = 16;

export class LocalKeyManagement implements KeyManagement {
  readonly keyId = 'local-kek-1';
  private readonly kek: Buffer;

  constructor(kekBase64: string) {
    this.kek = Buffer.from(kekBase64, 'base64');
    if (this.kek.length !== 32) throw new Error('LOCAL_KEK_BASE64 must decode to 32 bytes');
  }

  wrap(dataKey: Buffer, context: string): Buffer {
    return seal(this.kek, dataKey, context);
  }

  unwrap(wrapped: Buffer, context: string): Buffer {
    return open(this.kek, wrapped, context);
  }
}

/** AES-256-GCM. Output layout: iv (12) | tag (16) | ciphertext. `aad` binds the data to its context. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV + TAG) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()]);
}
