// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { credentialFingerprint, readCredential } from '../../src/proxy/request-credential.ts';

const withAuth = (value: string): Request =>
  new Request('https://git.example.com/', { headers: { Authorization: value } });
const basic = (user: string, password: string): string =>
  `Basic ${btoa(String.fromCodePoint(...new TextEncoder().encode(`${user}:${password}`)))}`;

describe('readCredential', () => {
  it('reads the Basic password as the bearer credential, keeping the user name', () => {
    expect(readCredential(withAuth(basic('x-access-token', 'eyJ.abc.def')))).toEqual({
      scheme: 'basic',
      username: 'x-access-token',
      secret: 'eyJ.abc.def',
    });
  });

  it('reads a Bearer token, in any case of the scheme', () => {
    expect(readCredential(withAuth('bearer tok'))).toEqual({
      scheme: 'bearer',
      username: null,
      secret: 'tok',
    });
  });

  it('round-trips any user name and password, unicode and colons in the password included (property)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((user) => !user.includes(':')),
        fc.string({ minLength: 1 }),
        (user, password) => {
          expect(readCredential(withAuth(basic(user, password)))).toEqual({
            scheme: 'basic',
            username: user,
            secret: password,
          });
        },
      ),
    );
  });

  it.each([
    ['no header', null],
    ['a scheme alone', 'Basic'],
    ['an unknown scheme', 'Digest abc'],
    ['bad base64', 'Basic !!!'],
    ['no colon', `Basic ${btoa('justuser')}`],
    ['an empty password', `Basic ${btoa('user:')}`],
    ['an empty bearer token', 'Bearer  '],
  ])('is null for %s', (_name, header) => {
    const request = header === null ? new Request('https://git.example.com/') : withAuth(header);
    expect(readCredential(request)).toBeNull();
  });
});

describe('credentialFingerprint', () => {
  it('is the SHA-256 of the secret alone, never the secret', async () => {
    const one = await credentialFingerprint({ scheme: 'basic', username: 'a', secret: 'secret' });
    const two = await credentialFingerprint({ scheme: 'bearer', username: null, secret: 'secret' });
    expect(one).toBe('2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b');
    expect(two).toBe(one);
  });
});
