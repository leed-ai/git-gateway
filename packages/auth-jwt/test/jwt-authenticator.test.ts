// SPDX-License-Identifier: Apache-2.0
import { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import { describe, expect, it } from 'vite-plus/test';

import { JwtAuthenticator } from '../src/jwt-authenticator.ts';
import type { JwtAlgorithm } from '../src/schemas/jwt-algorithm.ts';
import {
  basicRequest,
  generateTestKey,
  issuerFetch,
  signToken,
  type TestKey,
} from './helpers/token-issuer.ts';

const ISSUER = 'https://auth.example.com';
const NOW = new Date('2026-11-20T09:30:00.000Z');
const SECONDS = NOW.getTime() / 1000;

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: 'git.example.com', sub: 'user:42', exp: SECONDS + 3600, ...extra };
}

async function setup(
  algorithm: JwtAlgorithm = 'RS256',
  options: { algorithms?: JwtAlgorithm[]; now?: () => Date } = {},
) {
  const key = await generateTestKey(algorithm, 'key-1');
  let keys: TestKey[] = [key];
  const issuer = issuerFetch(ISSUER, () => keys);
  const authenticator = new JwtAuthenticator(
    {
      issuer: ISSUER,
      audience: ['git.example.com'],
      ...(options.algorithms ? { algorithms: options.algorithms } : {}),
    },
    { fetch: issuer.fetch, now: options.now ?? (() => NOW) },
  );
  return {
    authenticator,
    issuer,
    key,
    rotate: (next: TestKey[]) => {
      keys = next;
    },
  };
}

describe('JwtAuthenticator', () => {
  it.each<JwtAlgorithm>([
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'EdDSA',
    'Ed25519',
  ])('accepts a valid %s token sent as the Basic password and maps its claims', async (algorithm) => {
    const { authenticator, key } = await setup(algorithm, { algorithms: [algorithm] });
    const token = await signToken(
      key,
      claims({ name: 'Ada', email: 'ada@example.com', roles: ['maintainer', 'editor'] }),
    );
    const principal = await authenticator.authenticate(basicRequest(token));
    expect(Principal.parse(principal)).toEqual({
      subject: 'user:42',
      name: 'Ada',
      email: 'ada@example.com',
      roles: ['maintainer', 'editor'],
      // exp plus the default 60 seconds of clock tolerance, the token's last accepted moment.
      expiresAt: new Date((SECONDS + 3660) * 1000).toISOString(),
    });
  });

  it('accepts a Bearer token, an audience array and space-separated roles; drops bad optional claims', async () => {
    const { authenticator, key } = await setup();
    const token = await signToken(
      key,
      claims({ aud: ['other', 'git.example.com'], roles: 'a b,c', email: 'nope', name: '' }),
    );
    const request = new Request('https://git.example.com/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await authenticator.authenticate(request)).toMatchObject({
      roles: ['a', 'b', 'c'],
      email: null,
      name: null,
    });
  });

  it('discovers the JWKS once through OIDC and reuses the cached keys', async () => {
    const { authenticator, key, issuer } = await setup();
    const token = await signToken(key, claims());
    await authenticator.authenticate(basicRequest(token));
    await authenticator.authenticate(basicRequest(token));
    expect(issuer.calls).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/jwks.json`]);
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example.com' }],
    ['another audience', { aud: 'elsewhere' }],
    ['an expiry in the past (beyond the tolerance)', { exp: SECONDS - 61 }],
    ['a not-before in the future (beyond the tolerance)', { nbf: SECONDS + 61 }],
    ['no subject', { sub: undefined }],
    ['no expiry', { exp: undefined }],
  ])('refuses a token with %s', async (_name, extra) => {
    const { authenticator, key } = await setup();
    expect(await authenticator.authenticate(basicRequest(await signToken(key, claims(extra))))).toBeNull();
  });

  it('allows clock skew within the tolerance, and expires the principal at the end of it', async () => {
    const { authenticator, key } = await setup();
    const token = await signToken(key, claims({ exp: SECONDS - 30, nbf: SECONDS + 30 }));
    const principal = await authenticator.authenticate(basicRequest(token));
    expect(principal?.expiresAt).toBe(new Date((SECONDS + 30) * 1000).toISOString());
    expect(Date.parse(principal?.expiresAt ?? '')).toBeGreaterThan(NOW.getTime());
  });

  it('refuses a tampered signature, an algorithm not configured, "none" and HS256', async () => {
    const { authenticator, key } = await setup();
    const token = await signToken(key, claims());
    const [header, payload] = token.split('.');
    const forged = `${header}.${btoa(JSON.stringify(claims({ sub: 'admin' }))).replaceAll('=', '')}.${token.split('.')[2]}`;
    expect(await authenticator.authenticate(basicRequest(forged))).toBeNull();
    const none = `${btoa(JSON.stringify({ alg: 'none' })).replaceAll('=', '')}.${payload}.`;
    expect(await authenticator.authenticate(basicRequest(none))).toBeNull();
    const es = await generateTestKey('ES256', 'key-1');
    expect(await authenticator.authenticate(basicRequest(await signToken(es, claims())))).toBeNull();
    const hs = await signToken(key, claims(), { alg: 'HS256' });
    expect(await authenticator.authenticate(basicRequest(hs))).toBeNull();
  });

  it('refuses requests without a JWT', async () => {
    const { authenticator } = await setup();
    expect(await authenticator.authenticate(new Request('https://git.example.com/'))).toBeNull();
    expect(await authenticator.authenticate(basicRequest('not-a-jwt'))).toBeNull();
    expect(await authenticator.authenticate(basicRequest('a.b.c'))).toBeNull();
  });

  it('refetches the keys when a token names an unknown kid, at most every 10 seconds', async () => {
    let now = NOW.getTime();
    const { authenticator, issuer, key, rotate } = await setup('RS256', { now: () => new Date(now) });
    await authenticator.authenticate(basicRequest(await signToken(key, claims())));
    const rotated = await generateTestKey('RS256', 'key-2');
    rotate([key, rotated]);
    const token = await signToken(rotated, claims());
    expect(await authenticator.authenticate(basicRequest(token))).toBeNull();
    expect(issuer.calls.length).toBe(2);
    now += 11_000;
    expect(await authenticator.authenticate(basicRequest(token))).not.toBeNull();
    expect(issuer.calls.length).toBe(3);
  });

  it('uses a configured JWKS URL without discovery, and fails loudly when the issuer is down', async () => {
    const key = await generateTestKey('ES256', 'k');
    const issuer = issuerFetch(ISSUER, () => [key]);
    const direct = new JwtAuthenticator(
      { issuer: ISSUER, audience: ['git.example.com'], jwksUrl: `${ISSUER}/jwks.json` },
      { fetch: issuer.fetch, now: () => NOW },
    );
    expect(await direct.authenticate(basicRequest(await signToken(key, claims())))).not.toBeNull();
    expect(issuer.calls).toEqual([`${ISSUER}/jwks.json`]);
    const down = new JwtAuthenticator(
      { issuer: ISSUER, audience: ['git.example.com'] },
      { fetch: async () => new Response('down', { status: 503 }), now: () => NOW },
    );
    await expect(down.authenticate(basicRequest(await signToken(key, claims())))).rejects.toThrow(/503/);
  });

  it('serves the cached keys when a refresh fails, asking the issuer at most every 10 seconds', async () => {
    let now = NOW.getTime();
    const key = await generateTestKey('RS256', 'key-1');
    const issuer = issuerFetch(ISSUER, () => [key]);
    let down = false;
    const fetcher = async (request: Request): Promise<Response> =>
      down ? new Response('down', { status: 503 }) : issuer.fetch(request);
    let calls = 0;
    const authenticator = new JwtAuthenticator(
      { issuer: ISSUER, audience: ['git.example.com'], jwksUrl: `${ISSUER}/jwks.json` },
      {
        fetch: async (request) => {
          calls += 1;
          return fetcher(request);
        },
        now: () => new Date(now),
      },
    );
    const token = async () => signToken(key, claims({ exp: now / 1000 + 3600 }));
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    expect(calls).toBe(1);
    down = true;
    now += 601_000;
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    expect(calls).toBe(2);
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    const unknown = await signToken(
      await generateTestKey('RS256', 'key-9'),
      claims({ exp: now / 1000 + 3600 }),
    );
    expect(await authenticator.authenticate(basicRequest(unknown))).toBeNull();
    expect(calls).toBe(2);
    now += 10_000;
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    expect(calls).toBe(3);
    down = false;
    now += 10_000;
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    expect(calls).toBe(4);
    now += 1_000;
    expect(await authenticator.authenticate(basicRequest(await token()))).not.toBeNull();
    expect(calls).toBe(4);
  });

  it('fails without keys while the issuer is down, retrying at most every 10 seconds', async () => {
    let now = NOW.getTime();
    const key = await generateTestKey('RS256', 'key-1');
    let calls = 0;
    const authenticator = new JwtAuthenticator(
      { issuer: ISSUER, audience: ['git.example.com'], jwksUrl: `${ISSUER}/jwks.json` },
      {
        fetch: async () => {
          calls += 1;
          return new Response('down', { status: 503 });
        },
        now: () => new Date(now),
      },
    );
    const token = await signToken(key, claims());
    await expect(authenticator.authenticate(basicRequest(token))).rejects.toThrow(/503/);
    await expect(authenticator.authenticate(basicRequest(token))).rejects.toThrow(/503/);
    expect(calls).toBe(1);
    now += 10_000;
    await expect(authenticator.authenticate(basicRequest(token))).rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });

  it('refuses a discovery document naming another issuer', async () => {
    const key = await generateTestKey('RS256', 'k');
    const authenticator = new JwtAuthenticator(
      { issuer: ISSUER, audience: ['git.example.com'] },
      {
        fetch: async () =>
          Response.json({ issuer: 'https://other.example.com', jwks_uri: `${ISSUER}/jwks.json` }),
        now: () => NOW,
      },
    );
    await expect(authenticator.authenticate(basicRequest(await signToken(key, claims())))).rejects.toThrow(
      /issuer/,
    );
  });

  it('validates its configuration', () => {
    expect(() => new JwtAuthenticator({ issuer: 'not a url', audience: ['a'] })).toThrow(/url/i);
    expect(() => new JwtAuthenticator({ issuer: ISSUER, audience: [] })).toThrow(/too small/i);
  });
});
