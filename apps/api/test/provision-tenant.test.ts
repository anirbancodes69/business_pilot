import { describe, expect, it } from 'vitest';
import { parseProvisionArgs, ProvisionError, USAGE } from '../src/tenancy/provision-tenant';

describe('provision-tenant arguments', () => {
  it('accepts a name, a slug and one owner option', () => {
    expect(
      parseProvisionArgs([
        '--name',
        ' Acme Traders ',
        '--slug',
        'acme',
        '--owner-email',
        'a@x.test',
      ]),
    ).toEqual({ name: 'Acme Traders', slug: 'acme', ownerEmail: 'a@x.test' });
    expect(
      parseProvisionArgs(['--name', 'Acme', '--slug', 'acme-2', '--owner-subject', 'sub-1']),
    ).toEqual({ name: 'Acme', slug: 'acme-2', ownerSubject: 'sub-1' });
  });

  it.each([
    ['no owner', ['--name', 'A', '--slug', 'a']],
    [
      'both owners',
      ['--name', 'A', '--slug', 'a', '--owner-email', 'a@x.test', '--owner-subject', 's'],
    ],
    ['no name', ['--slug', 'a', '--owner-subject', 's']],
    ['blank name', ['--name', '  ', '--slug', 'a', '--owner-subject', 's']],
    ['upper-case slug', ['--name', 'A', '--slug', 'Acme', '--owner-subject', 's']],
    ['slug with a path', ['--name', 'A', '--slug', '../a', '--owner-subject', 's']],
    ['slug ending in a hyphen', ['--name', 'A', '--slug', 'a-', '--owner-subject', 's']],
    ['slug too long', ['--name', 'A', '--slug', 'a'.repeat(64), '--owner-subject', 's']],
    ['bad email', ['--name', 'A', '--slug', 'a', '--owner-email', 'not-an-email']],
    ['unknown option', ['--name', 'A', '--slug', 'a', '--owner-subject', 's', '--role', 'owner']],
    ['stray argument', ['--name', 'A', '--slug', 'a', '--owner-subject', 's', 'extra']],
  ])('refuses %s', (_n, argv) => {
    expect(() => parseProvisionArgs(argv)).toThrow(ProvisionError);
    expect(() => parseProvisionArgs(argv)).toThrow(USAGE);
  });
});
