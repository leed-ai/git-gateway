// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { createGatewayApp } from '../src/gateway-app.ts';
import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';
import { FakeBackend } from './helpers/fake-backend.ts';
import { FakeUpstream } from './helpers/fake-upstream.ts';
import { basic, gatewayFixture } from './helpers/gateway-fixture.ts';

const INFO_REFS = '/site.git/info/refs?service=git-upload-pack';

describe('authentication', () => {
  it('answers 401 with a Basic challenge when there is no credential, so git asks its credential helper', async () => {
    const { app, upstream, backend } = gatewayFixture();
    const response = await app.request(INFO_REFS);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="git-gateway"');
    expect(upstream.received).toEqual([]);
    expect(backend.minted).toEqual([]);
  });

  it('names the configured realm and answers 401 for an unknown credential', async () => {
    const { app } = gatewayFixture({ smartHttp: { realm: 'git.example.com' } });
    const response = await app.request(INFO_REFS, { headers: basic('wrong') });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="git.example.com"');
  });

  it('treats the Basic password as the bearer credential and accepts a Bearer header too', async () => {
    const { app } = gatewayFixture();
    expect((await app.request(INFO_REFS, { headers: basic('alice-token') })).status).toBe(200);
    expect((await app.request(INFO_REFS, { headers: { Authorization: 'Bearer bob-token' } })).status).toBe(
      200,
    );
  });

  it('caches the principal per credential for the configured time', async () => {
    let now = Date.parse('2026-11-20T09:00:00.000Z');
    const { app, calls } = gatewayFixture({ authCacheSeconds: 60, now: () => new Date(now) });
    await app.request(INFO_REFS, { headers: basic('alice-token') });
    await app.request(INFO_REFS, { headers: basic('alice-token') });
    expect(calls.authenticate).toBe(1);
    expect(calls.authorize).toBe(1);
    now += 61_000;
    await app.request(INFO_REFS, { headers: basic('alice-token') });
    expect(calls.authenticate).toBe(2);
    expect(calls.authorize).toBe(2);
  });

  it('does not cache when authCacheSeconds is 0', async () => {
    const { app, calls } = gatewayFixture({ authCacheSeconds: 0 });
    await app.request(INFO_REFS, { headers: basic('alice-token') });
    await app.request(INFO_REFS, { headers: basic('alice-token') });
    expect(calls.authenticate).toBe(2);
  });

  it('refuses an expired credential with 401 and never caches past the expiry', async () => {
    let now = Date.parse('2026-11-20T09:00:00.000Z');
    const { app, calls } = gatewayFixture({
      now: () => new Date(now),
      principals: { 'short-token': { subject: 'short', expiresAt: '2026-11-20T09:00:10.000Z' } },
    });
    expect((await app.request(INFO_REFS, { headers: basic('short-token') })).status).toBe(200);
    now += 11_000;
    const response = await app.request(INFO_REFS, { headers: basic('short-token') });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Basic /);
    expect(calls.authenticate).toBe(2);
  });

  it('answers 503 when the authenticator fails, without leaking why', async () => {
    const upstream = new FakeUpstream();
    const logs: string[] = [];
    const app = createGatewayApp({
      backend: new FakeBackend(),
      authenticator: {
        authenticate: async () => {
          throw new Error('jwks unreachable');
        },
      },
      authorizer: { authorize: async () => true },
      branchPolicy: new RuleBranchPolicy(),
      logger: { log: (entry) => logs.push(JSON.stringify(entry)) },
      fetch: upstream.fetch,
    });
    const response = await app.request(INFO_REFS, { headers: basic('alice-token') });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/jwks/);
    expect(logs.join('\n')).toMatch(/jwks unreachable/);
  });

  it('never writes a client or upstream credential to a log or a response', async () => {
    const { app, logs, backend } = gatewayFixture();
    const responses = [
      await app.request(INFO_REFS, { headers: basic('alice-token') }),
      await app.request(INFO_REFS, { headers: basic('wrong-secret') }),
      await app.request('/site.git/git-receive-pack', {
        method: 'POST',
        headers: basic('reader-token'),
        body: '0000',
      }),
    ];
    const text = [
      JSON.stringify(logs),
      ...(await Promise.all(responses.map(async (response) => response.text()))),
    ].join('\n');
    const headers = responses.flatMap((response) => [...response.headers.values()]).join('\n');
    for (const secret of [
      'alice-token',
      'wrong-secret',
      'reader-token',
      ...backend.minted.map((minted) => minted.token),
    ]) {
      expect(text).not.toContain(secret);
      expect(headers).not.toContain(secret);
    }
  });
});
