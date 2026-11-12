import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Claims of contracts/tenant/request-context.schema.json. ai-engine treats the token as opaque.
const claimsSchema = z.strictObject({
  request_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  authz_scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  semantic_model_version: z.number().int().min(1),
  max_tool_calls: z.number().int().min(1).max(20).optional(),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export type RequestContextClaims = z.infer<typeof claimsSchema>;

export const DEFAULT_TTL_SECONDS = 120;

const b64 = (b: Buffer): string => b.toString('base64url');
const mac = (key: string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

export class RequestContextError extends Error {}

/**
 * HMAC-SHA256 signed, short-lived token binding AI tool calls to one authenticated request (P-19).
 * `keys[0]` signs. Every key in `keys` verifies, which allows rotation with an overlap window.
 * The api must still reload authorization from its own state: nothing in the token grants access.
 */
export class RequestContextSigner {
  constructor(
    private readonly keys: string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (keys.length === 0 || keys.some((k) => k.length < 32)) {
      throw new Error('REQUEST_CONTEXT_SIGNING_KEY must be at least 32 characters');
    }
  }

  issue(
    claims: Omit<RequestContextClaims, 'issued_at' | 'expires_at'>,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): string {
    const issued = this.now();
    const full = claimsSchema.parse({
      ...claims,
      issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + ttlSeconds * 1000).toISOString(),
    });
    const payload = b64(Buffer.from(JSON.stringify(full)));
    const signingKey = this.keys[0] as string;
    return `${payload}.${b64(mac(signingKey, payload))}`;
  }

  /** Throws RequestContextError on a bad signature, expiry, malformed claims or request_id mismatch. */
  verify(token: string, expectedRequestId: string): RequestContextClaims {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) throw new RequestContextError('malformed');
    const given = Buffer.from(signature, 'base64url');
    const valid = this.keys.some((k) => {
      const expected = mac(k, payload);
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
    if (!valid) throw new RequestContextError('bad signature');
    let claims: RequestContextClaims;
    try {
      claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new RequestContextError('malformed claims');
    }
    const now = this.now().getTime();
    if (Date.parse(claims.expires_at) <= now) throw new RequestContextError('expired');
    if (Date.parse(claims.issued_at) > now + 5000)
      throw new RequestContextError('issued in the future');
    if (claims.request_id !== expectedRequestId)
      throw new RequestContextError('request_id mismatch');
    return claims;
  }
}
