// SPDX-License-Identifier: Apache-2.0
import { decodePktLines, packetText } from '@leed-ai/git-gateway-core/pkt-line/decode';
import { describe, expect, it } from 'vite-plus/test';

import { createGatewayApp } from '../src/gateway-app.ts';
import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';
import { FakeBackend } from './helpers/fake-backend.ts';
import { FakeUpstream } from './helpers/fake-upstream.ts';
import { basic, gatewayFixture, settle } from './helpers/gateway-fixture.ts';

const lines = async (response: Response): Promise<(string | null)[]> =>
  decodePktLines(new Uint8Array(await response.arrayBuffer())).map(packetText);

describe('authorization', () => {
  it('refuses a push advertisement in-protocol with an ERR after the service preamble', async () => {
    const { app, upstream, backend, audits } = gatewayFixture();
    const response = await app.request('/site.git/info/refs?service=git-receive-pack', {
      headers: basic('reader-token'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-git-receive-pack-advertisement');
    expect(await lines(response)).toEqual([
      '# service=git-receive-pack',
      null,
      'ERR access denied: reader may not push to site',
    ]);
    expect(upstream.received).toEqual([]);
    expect(backend.minted).toEqual([]);
    await settle();
    expect(audits).toMatchObject([
      {
        principal: { subject: 'reader' },
        repo: 'site',
        operation: 'write',
        endpoint: 'info-refs',
        outcome: 'denied',
      },
    ]);
  });

  it('refuses a receive-pack POST with a bare ERR packet', async () => {
    const { app } = gatewayFixture();
    const response = await app.request('/site.git/git-receive-pack', {
      method: 'POST',
      headers: basic('reader-token'),
      body: '0000',
    });
    expect(response.headers.get('Content-Type')).toBe('application/x-git-receive-pack-result');
    expect(await lines(response)).toEqual(['ERR access denied: reader may not push to site']);
  });

  it('answers a refusal with HTTP 403 and the reason when deniedStatus is 403', async () => {
    const { app, upstream, audits } = gatewayFixture({ smartHttp: { deniedStatus: 403 } });
    for (const request of [
      app.request('/site.git/info/refs?service=git-receive-pack', { headers: basic('reader-token') }),
      app.request('/site.git/git-receive-pack', {
        method: 'POST',
        headers: basic('reader-token'),
        body: '0000',
      }),
    ]) {
      const response = await request;
      expect(response.status).toBe(403);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('X-Request-Id')).toBeTruthy();
      expect(await response.text()).toBe('access denied: reader may not push to site\n');
    }
    expect(upstream.received).toEqual([]);
    await settle();
    expect(audits.map((event) => event.outcome)).toEqual(['denied', 'denied']);
  });

  it('still lets a permitted reader fetch when deniedStatus is 403', async () => {
    const { app } = gatewayFixture({ smartHttp: { deniedStatus: 403 } });
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('reader-token'),
    });
    expect(response.status).toBe(200);
  });

  it('lets a reader fetch', async () => {
    const { app } = gatewayFixture();
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('reader-token'),
    });
    expect(response.status).toBe(200);
  });

  it('caches refusals as well as grants', async () => {
    const { app, calls } = gatewayFixture();
    await app.request('/site.git/info/refs?service=git-receive-pack', { headers: basic('reader-token') });
    await app.request('/site.git/info/refs?service=git-receive-pack', { headers: basic('reader-token') });
    expect(calls.authorize).toBe(1);
  });

  it('answers 503 when the authorizer fails', async () => {
    const app = createGatewayApp({
      backend: new FakeBackend(),
      authenticator: { authenticate: async () => ({ subject: 'alice' }) },
      authorizer: {
        authorize: async () => {
          throw new Error('policy store down');
        },
      },
      branchPolicy: new RuleBranchPolicy(),
      fetch: new FakeUpstream().fetch,
    });
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('x'),
    });
    expect(response.status).toBe(503);
  });

  it('keeps answering when the audit hook throws', async () => {
    const logs: string[] = [];
    const app = createGatewayApp({
      backend: new FakeBackend(),
      authenticator: { authenticate: async () => ({ subject: 'alice' }) },
      authorizer: { authorize: async () => false },
      branchPolicy: new RuleBranchPolicy(),
      audit: () => {
        throw new Error('audit sink down');
      },
      logger: { log: (entry) => logs.push(entry.message) },
      fetch: new FakeUpstream().fetch,
    });
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('x'),
    });
    expect(response.status).toBe(200);
    await settle();
    expect(logs).toContain('audit hook failed');
  });
});
