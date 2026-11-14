import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesSchema, ConnectorConfigError } from '../src/connectors/connector';
import { ConnectorRegistry } from '../src/connectors/connector-registry';
import { isBlockedAddress, resolveAllowedHost } from '../src/connectors/egress';
import { PostgresConnector } from '../src/connectors/postgresql/postgresql.connector';
import { loadEnv } from '../src/platform/config/env';

const guarded = new PostgresConnector({ allowPrivateNetworks: false });

describe('egress guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    // The same internal addresses in other spellings: the guard must judge bytes, not text.
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', // cloud metadata, hex form
    '::ffff:0a00:0001',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:7f00:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::7f00:1', // IPv4-compatible
    '64:ff9b::7f00:1', // NAT64
    '64:ff9b:1::1',
    '2002:7f00:1::1', // 6to4 carrying 127.0.0.1
    '2002:a00:1::1', // 6to4 carrying 10.0.0.1
    '2001:0:1::1', // Teredo
    '2001:db8::1', // documentation
    'ff02::1', // multicast
    'fec0::1', // site-local (deprecated)
    '100::1', // discard prefix, not global unicast
    'fe80::1%eth0', // scoped
    'not-an-address',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '203.0.113.7',
    '2606:4700:4700::1111',
    '2606:4700:4700:0:0:0:0:1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '2002:808:808::1', // 6to4 carrying a public address
  ])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it('refuses internal literals and unresolvable names unless private networks are allowed', async () => {
    await expect(resolveAllowedHost('169.254.169.254', false)).rejects.toThrow('not allowed');
    await expect(resolveAllowedHost('127.0.0.1', false)).rejects.toThrow('not allowed');
    await expect(resolveAllowedHost('::ffff:7f00:1', false)).rejects.toThrow('not allowed');
    await expect(resolveAllowedHost('0:0:0:0:0:0:0:1', false)).rejects.toThrow('not allowed');
    await expect(resolveAllowedHost('localhost', false)).rejects.toThrow('not allowed');
    await expect(resolveAllowedHost('no-such-host.invalid', false)).rejects.toThrow('resolved');
    await expect(resolveAllowedHost('127.0.0.1', true)).resolves.toBe('127.0.0.1');
  });
});

describe('PostgreSQL connector configuration', () => {
  const ok = { host: 'db.example.com', port: 5432, database: 'sales' };

  it('applies defaults', () => {
    expect(guarded.parseConfig(ok)).toMatchObject({ schema: 'public', tls_mode: 'verify-full' });
  });

  it('rejects unknown keys, bad ports and unsafe schema names', () => {
    expect(() => guarded.parseConfig({ ...ok, extra: 1 })).toThrow(ConnectorConfigError);
    expect(() => guarded.parseConfig({ ...ok, port: 70000 })).toThrow(ConnectorConfigError);
    expect(() => guarded.parseConfig({ ...ok, schema: 'public; DROP TABLE x' })).toThrow(
      ConnectorConfigError,
    );
  });

  it('refuses TLS-off outside development', () => {
    expect(() => guarded.parseConfig({ ...ok, tls_mode: 'disable' })).toThrow(ConnectorConfigError);
    const dev = new PostgresConnector({ allowPrivateNetworks: true });
    expect(dev.parseConfig({ ...ok, tls_mode: 'disable' })).toMatchObject({ tls_mode: 'disable' });
  });

  it('does not echo a submitted secret in validation problems', () => {
    const secret = 'S3cret-Passw0rd-value';
    try {
      guarded.parseCredentials({ username: 'u', password: secret, unexpected: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorConfigError);
      expect(JSON.stringify((error as ConnectorConfigError).problems)).not.toContain(secret);
    }
  });
});

describe('connector registry and capability descriptor', () => {
  const registry = new ConnectorRegistry(
    loadEnv({ POSTGRES_APP_PASSWORD: 'x' } as NodeJS.ProcessEnv),
  );

  it('registers PostgreSQL with a valid descriptor', () => {
    expect(registry.get('postgresql')).toBeDefined();
    expect(registry.get('nope')).toBeUndefined();
    const [caps] = registry.list();
    expect(capabilitiesSchema.safeParse(caps).success).toBe(true);
    expect(caps?.access_modes).toEqual(['managed_sync']);
  });

  it('refuses duplicate registration and a mismatched descriptor', () => {
    expect(() => registry.register(guarded)).toThrow('already registered');
    const liar = Object.create(guarded) as PostgresConnector;
    Object.defineProperty(liar, 'type', { value: 'mysql' });
    expect(() => registry.register(liar)).toThrow('different capability type');
  });

  it('the Zod descriptor allows the same values as the JSON contract', () => {
    const json = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../contracts/connector/connector-capabilities.schema.json'),
        'utf8',
      ),
    ) as { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> };
    const zodShape = capabilitiesSchema.shape;
    for (const name of [
      'access_modes',
      'change_detection',
      'delete_detection',
      'schema_discovery',
      'key_strategy',
    ] as const) {
      const isArray = json.properties[name]?.items !== undefined;
      const expected = json.properties[name]?.enum ?? json.properties[name]?.items?.enum ?? [];
      const wrap = (v: string) => (isArray ? [v] : v);
      expect(
        expected.filter((v) => zodShape[name].safeParse(wrap(v)).success),
        name,
      ).toEqual(expected);
      expect(zodShape[name].safeParse(wrap('bogus')).success, name).toBe(false);
    }
  });
});
