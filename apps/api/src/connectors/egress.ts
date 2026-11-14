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

/**
 * Parses an IPv6 literal into its 16 bytes, whatever its spelling (compressed, fully written out,
 * or with a dotted IPv4 tail). Returns null for anything else, including scoped addresses (`%eth0`).
 */
function ipv6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null;
  let text = ip;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1] !== undefined && tail[2] !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = tail[2].split('.').map(Number);
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * True when the address must not be reached. The decision is made on the address bytes, never on
 * its text, so alternate spellings of an internal address (`::ffff:7f00:1`, `0:0:0:0:0:0:0:1`)
 * cannot pass. IPv6 is allow-listed: only global unicast (2000::/3) is reachable, and addresses
 * that carry an IPv4 address inside them are judged by that IPv4 address.
 */
export function isBlockedAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIP(lower) === 4) return ipv4Blocked(lower);
  const b = ipv6Bytes(lower);
  if (!b) return true; // not an address we understand: fail closed
  const at = (i: number): number => b[i] ?? 0;
  const v4 = (i: number): string => `${at(i)}.${at(i + 1)}.${at(i + 2)}.${at(i + 3)}`;
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);

  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form (::a.b.c.d).
  if (zero(0, 10) && at(10) === 0xff && at(11) === 0xff) return ipv4Blocked(v4(12));
  if (zero(0, 12)) return true; // ::, ::1 and IPv4-compatible addresses
  // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48) translates to an IPv4 address.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) return true;
  // Only global unicast from here on.
  if ((at(0) & 0xe0) !== 0x20) return true;
  // 6to4 (2002::/16) embeds an IPv4 address; Teredo (2001::/32) tunnels to one.
  if (at(0) === 0x20 && at(1) === 0x02) return ipv4Blocked(v4(2));
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) return true;
  // Documentation range (2001:db8::/32).
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return true;
  return false;
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
