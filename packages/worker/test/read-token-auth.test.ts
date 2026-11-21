// SPDX-License-Identifier: Apache-2.0
import { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import { describe, expect, it } from 'vite-plus/test';

import { ReadTokenAuthenticator, readTokenAuthorizer, withReadTokens } from '../src/auth/read-token-auth.ts';
import { createGatewayApp } from '../src/gateway-app.ts';
import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';
import { mintReadToken } from '../src/rpc/read-token.ts';
import { FakeBackend } from './helpers/fake-backend.ts';
import { FakeUpstream } from './helpers/fake-upstream.ts';
import { basic } from './helpers/gateway-fixture.ts';
import { SECRET } from './helpers/memory-gateway.ts';

const NOW = new Date('2026-11-20T09:30:00.000Z');
const now = () => NOW;
const request = (headers: Record<string, string>) =>
  new Request('https://git.example.com/acme.git/info/refs', { headers });
const mint = async (repo = 'acme', ttlSeconds = 900, at = NOW) =>
  (await mintReadToken({ repo, ttlSeconds, secret: SECRET, now: at })).token;

/** The deployment's own authenticator and authorizer: "own-token" is a writer of everything. */
const own = {
  authenticator: {
    authenticate: async (incoming: Request) => {
      const header = incoming.headers.get('Authorization') ?? '';
      if (header === 'Bearer own-token') return { subject: 'alice', roles: ['maintainer'] };
      if (header === 'Bearer spoof-token') return { subject: 'read-token:abc', roles: ['read:secret'] };
      return null;
    },
  },
  authorizer: { authorize: async () => true },
};

describe('ReadTokenAuthenticator', () => {
  it('turns a minted token into a read principal for its repository that expires with it', async () => {
    const authenticator = new ReadTokenAuthenticator({ secret: SECRET, now });
    const principal = Principal.parse(await authenticator.authenticate(request(basic(await mint()))));
    expect(principal).toMatchObject({ roles: ['read:acme'], expiresAt: '2026-11-20T09:45:00.000Z' });
    expect(principal.subject).toMatch(/^read-token:[0-9a-f]{32}$/);
    const bearer = await authenticator.authenticate(request({ Authorization: `Bearer ${await mint()}` }));
    expect(bearer).toMatchObject({ roles: ['read:acme'] });
  });

  it('refuses expired, forged and foreign credentials', async () => {
    const authenticator = new ReadTokenAuthenticator({ secret: SECRET, now });
    const expired = await mint('acme', 60, new Date(NOW.getTime() - 120_000));
    expect(await authenticator.authenticate(request(basic(expired)))).toBeNull();
    const other = (await mintReadToken({ repo: 'acme', ttlSeconds: 900, secret: 'x'.repeat(32), now: NOW }))
      .token;
    expect(await authenticator.authenticate(request(basic(other)))).toBeNull();
    expect(await authenticator.authenticate(request(basic('own-token')))).toBeNull();
    expect(await authenticator.authenticate(request({}))).toBeNull();
  });
});

describe('readTokenAuthorizer', () => {
  const authorizer = readTokenAuthorizer({ authorize: async () => true });
  const reader = Principal.parse({ subject: 'read-token:0', roles: ['read:acme'] });

  it('lets a read-token principal read its repository and nothing else', async () => {
    expect(await authorizer.authorize(reader, 'acme', 'read')).toBe(true);
    expect(await authorizer.authorize(reader, 'acme', 'write')).toBe(false);
    expect(await authorizer.authorize(reader, 'other', 'read')).toBe(false);
  });

  it('leaves every other principal to the fallback', async () => {
    const alice = Principal.parse({ subject: 'alice' });
    expect(await authorizer.authorize(alice, 'other', 'write')).toBe(true);
  });
});

describe('withReadTokens', () => {
  const chained = withReadTokens({ secret: SECRET, now, ...own });

  it('accepts read tokens and the deployment credentials side by side', async () => {
    expect(await chained.authenticator.authenticate(request(basic(await mint())))).toMatchObject({
      roles: ['read:acme'],
    });
    expect(
      await chained.authenticator.authenticate(request({ Authorization: 'Bearer own-token' })),
    ).toMatchObject({
      subject: 'alice',
    });
  });

  it('never hands an invalid read token on to the deployment authenticator', async () => {
    let asked = 0;
    const counting = withReadTokens({
      secret: SECRET,
      now,
      authenticator: {
        authenticate: async () => {
          asked += 1;
          return { subject: 'alice' };
        },
      },
      authorizer: own.authorizer,
    });
    expect(await counting.authenticator.authenticate(request(basic('ggr_forged.token')))).toBeNull();
    expect(asked).toBe(0);
  });

  it('refuses a deployment principal that claims the read-token subject namespace', async () => {
    expect(
      await chained.authenticator.authenticate(request({ Authorization: 'Bearer spoof-token' })),
    ).toBeNull();
  });
});

describe('read tokens through the gateway', () => {
  it('serves a fetch to a read token and refuses its push and other repositories', async () => {
    const upstream = new FakeUpstream();
    const app = createGatewayApp({
      backend: new FakeBackend(),
      ...withReadTokens({ secret: SECRET, now, ...own }),
      branchPolicy: new RuleBranchPolicy({}),
      fetch: upstream.fetch,
      now,
    });
    const token = await mint('site');
    const fetchRefs = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic(token),
    });
    expect(fetchRefs.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    const pushRefs = await app.request('/site.git/info/refs?service=git-receive-pack', {
      headers: basic(token),
    });
    expect(await pushRefs.text()).toContain('access denied');
    const otherRepo = await app.request('/other.git/info/refs?service=git-upload-pack', {
      headers: basic(token),
    });
    expect(await otherRepo.text()).toContain('access denied');
    expect(upstream.received).toHaveLength(1);
  });
});
