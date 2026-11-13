import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EgressDeniedError } from './connector';

// Egress guard (ADR-0004): a tenant-supplied host must not reach internal addresses (SSRF).
// The caller connects to the returned address, not to the name, so the check cannot be bypassed
// by a DNS answer that changes between the check and the connection.

function ipv4Blocked(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isBlockedAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIP(lower) === 4) return ipv4Blocked(lower);
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return ipv4Blocked(mapped[1]);
  return (
    lower.startsWith('fc') || // unique local
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower) || // link-local
    lower.startsWith('ff') // multicast
  );
}

/** Resolves the host and returns one allowed address. Fails closed. */
export async function resolveAllowedHost(host: string, allowPrivate: boolean): Promise<string> {
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new EgressDeniedError('host could not be resolved');
    }
  }
  if (addresses.length === 0) throw new EgressDeniedError('host could not be resolved');
  // Every answer must be allowed, otherwise a mixed answer could hide an internal address.
  if (!allowPrivate && addresses.some(isBlockedAddress))
    throw new EgressDeniedError('host is not allowed');
  return addresses[0] as string;
}
