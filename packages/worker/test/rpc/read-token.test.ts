// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { mintReadToken, READ_TOKEN_PREFIX, verifyReadToken } from '../../src/rpc/read-token.ts';
import { memoryGateway, SECRET } from '../helpers/memory-gateway.ts';

const NOW = new Date('2026-11-20T09:30:00.000Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');

describe('read tokens', () => {
  it('verifies a token it minted until it expires, and not after', async () => {
    const { token, expiresAt } = await mintReadToken({
      repo: 'acme',
      ttlSeconds: 900,
      secret: SECRET,
      now: NOW,
    });
    expect(token.startsWith(READ_TOKEN_PREFIX)).toBe(true);
    expect(expiresAt).toBe('2026-11-20T09:45:00.000Z');
    expect(await verifyReadToken(token, SECRET, later(899))).toMatchObject({
      v: 1,
      repo: 'acme',
      exp: NOW.getTime() / 1000 + 900,
    });
    expect(await verifyReadToken(token, SECRET, later(900))).toBeNull();
  });

  it('rejects tokens signed with another secret, tampered with, or malformed', async () => {
    const { token } = await mintReadToken({ repo: 'acme', ttlSeconds: 900, secret: SECRET, now: NOW });
    const [payload, signature] = token.slice(READ_TOKEN_PREFIX.length).split('.');
    const forgedClaims = btoa(
      JSON.stringify({ v: 1, repo: 'other', iat: 1, exp: 9_999_999_999, jti: '0'.repeat(32) }),
    )
      .replaceAll('=', '')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
    for (const bad of [
      // The signature's first character: every one of its bits counts, unlike the last one's,
      // whose low bits are padding a lenient decoder ignores.
      `${READ_TOKEN_PREFIX}${payload}.${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`,
      `${READ_TOKEN_PREFIX}${forgedClaims}.${signature}`,
      `${READ_TOKEN_PREFIX}${payload}`,
      `${READ_TOKEN_PREFIX}${payload}.${signature}.extra`,
      `${READ_TOKEN_PREFIX}${payload}.!!!`,
      `xyz_${payload}.${signature}`,
      `${READ_TOKEN_PREFIX}${'a'.repeat(5000)}`,
      '',
    ]) {
      expect(await verifyReadToken(bad, SECRET, NOW)).toBeNull();
    }
    expect(await verifyReadToken(token, `${SECRET}-rotated`, NOW)).toBeNull();
  });

  it('rejects a validly signed payload that is not valid claims', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    for (const body of ['not json', JSON.stringify({ v: 2, repo: 'acme' })]) {
      const payload = encode(new TextEncoder().encode(body));
      const signature = encode(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
      );
      expect(await verifyReadToken(`${READ_TOKEN_PREFIX}${payload}.${signature}`, SECRET, NOW)).toBeNull();
    }
  });

  it('refuses a secret shorter than 32 characters', async () => {
    await expect(mintReadToken({ repo: 'acme', ttlSeconds: 60, secret: 'short', now: NOW })).rejects.toThrow(
      /expected string to have >=32 characters/,
    );
  });

  it('round-trips any repository and lifetime, and two tokens never collide', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}$/),
        fc.integer({ min: 60, max: 86_400 }),
        async (repo, ttlSeconds) => {
          const a = await mintReadToken({ repo, ttlSeconds, secret: SECRET, now: NOW });
          const b = await mintReadToken({ repo, ttlSeconds, secret: SECRET, now: NOW });
          expect(a.token).not.toBe(b.token);
          expect((await verifyReadToken(a.token, SECRET, later(ttlSeconds - 1)))?.repo).toBe(repo);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('mintReadToken RPC', () => {
  it('mints a token for an existing repository with its gateway clone URL', async () => {
    const { gateway } = memoryGateway({
      now: () => NOW,
      config: { publicBaseUrl: 'https://git.example.com' },
    });
    await gateway.createRepo({ repo: 'acme' });
    const output = await gateway.mintReadToken({ repo: 'acme', ttlSeconds: 600 });
    expect(output).toEqual({
      token: expect.stringMatching(/^ggr_/),
      expiresAt: '2026-11-20T09:40:00.000Z',
      remoteUrl: 'https://git.example.com/acme.git',
    });
    expect((await verifyReadToken(output.token, SECRET, NOW))?.repo).toBe('acme');
  });

  it('refuses a missing repository', async () => {
    const { gateway } = memoryGateway();
    await expect(gateway.mintReadToken({ repo: 'missing' })).rejects.toThrow(/repo_not_found/);
  });
});
