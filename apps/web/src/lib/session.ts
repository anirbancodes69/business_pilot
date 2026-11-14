import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Sealed session (ADR-0020). The tokens live only on the server side of the cookie: the value is
// AES-256-GCM encrypted, so browser JavaScript could not read it even if the cookie were visible
// (it is also HttpOnly). A cookie holds about 4 KB, so a long value is split across cookies.

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
  tenantId: string;
  tenantName: string | null;
}

export const SESSION_COOKIE = 'bp_session';
export const LOGIN_COOKIE = 'bp_login';
const CHUNK = 3400;
const MAX_CHUNKS = 6;

const keyOf = (secret: string): Buffer => createHash('sha256').update(secret).digest();

export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal<T>(token: string, secret: string): T | undefined {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    return JSON.parse(text) as T;
  } catch {
    return undefined; // tampered, wrong key or malformed: no session
  }
}

/** The small part of the Next.js cookie store that this module needs. */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
  delete(name: string): void;
}

const chunkName = (i: number): string => (i === 0 ? SESSION_COOKIE : `${SESSION_COOKIE}_${i}`);

export function readSession(jar: CookieJar, secret: string): Session | undefined {
  let sealed = '';
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = jar.get(chunkName(i))?.value;
    if (part === undefined) break;
    sealed += part;
  }
  if (!sealed) return undefined;
  const s = unseal<Session>(sealed, secret);
  return s && typeof s.accessToken === 'string' && typeof s.tenantId === 'string' ? s : undefined;
}

export function cookieOptions(secure: boolean, maxAgeSeconds: number): Record<string, unknown> {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds };
}

export function writeSession(
  jar: CookieJar,
  session: Session,
  secret: string,
  secure: boolean,
  maxAgeSeconds = 8 * 3600,
): void {
  const sealed = seal(session, secret);
  const parts = sealed.match(new RegExp(`.{1,${CHUNK}}`, 'g')) ?? [];
  if (parts.length > MAX_CHUNKS) throw new Error('session too large');
  parts.forEach((p, i) => jar.set(chunkName(i), p, cookieOptions(secure, maxAgeSeconds)));
  for (let i = parts.length; i < MAX_CHUNKS; i++) jar.delete(chunkName(i));
}

export function clearSession(jar: CookieJar): void {
  for (let i = 0; i < MAX_CHUNKS; i++) jar.delete(chunkName(i));
}
