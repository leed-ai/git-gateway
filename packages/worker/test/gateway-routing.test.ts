// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { basic, gatewayFixture } from './helpers/gateway-fixture.ts';

describe('gateway routing', () => {
  it('serves GET /health without authentication', async () => {
    const { app, calls } = gatewayFixture();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'git-gateway' });
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.authenticate).toBe(0);
  });

  it.each([
    ['/', 'GET'],
    ['/site/info/refs?service=git-upload-pack', 'GET'],
    ['/site.git/objects/info/packs', 'GET'],
    ['/.bad.git/info/refs?service=git-upload-pack', 'GET'],
    ['/site.git.git/info/refs?service=git-upload-pack', 'GET'],
    ['/%E0%A4%A.git/info/refs?service=git-upload-pack', 'GET'],
  ])('answers 404 for %s before authenticating', async (path, method) => {
    const { app, calls } = gatewayFixture();
    expect((await app.request(path, { method })).status).toBe(404);
    expect(calls.authenticate).toBe(0);
  });

  it('refuses dumb HTTP with 403', async () => {
    const { app } = gatewayFixture();
    const response = await app.request('/site.git/info/refs');
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/Dumb HTTP/);
    expect((await app.request('/site.git/info/refs?service=git-annex')).status).toBe(403);
  });

  it.each([
    ['/site.git/info/refs?service=git-upload-pack', 'POST', 'GET'],
    ['/site.git/git-upload-pack', 'GET', 'POST'],
    ['/site.git/git-receive-pack', 'PUT', 'POST'],
  ])('answers 405 for %s with %s', async (path, method, allow) => {
    const { app } = gatewayFixture();
    const response = await app.request(path, { method, headers: basic('alice-token') });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(allow);
  });

  it('uses a valid CF-Ray header as the request id and logs one entry per request', async () => {
    const { app, logs } = gatewayFixture();
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: { ...basic('alice-token'), 'CF-Ray': '8f1c2d3e4a5b6c7d-LHR' },
    });
    expect(response.headers.get('X-Request-Id')).toBe('8f1c2d3e4a5b6c7d-LHR');
    const entry = logs.find((log) => log.message === 'request');
    expect(entry).toMatchObject({
      requestId: '8f1c2d3e4a5b6c7d-LHR',
      method: 'GET',
      path: '/site.git/info/refs',
      service: 'git-upload-pack',
      status: 200,
      repo: 'site',
      endpoint: 'info-refs',
      principal: 'alice',
    });
  });

  it('ignores a CF-Ray header that is not a valid request id', async () => {
    const { app } = gatewayFixture();
    const response = await app.request('/health', { headers: { 'CF-Ray': 'bad id with spaces' } });
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers 502 without detail when minting the storage remote fails unexpectedly', async () => {
    const { app, backend, logs } = gatewayFixture();
    backend.gitRemote = async () => {
      throw new TypeError('boom');
    };
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('alice-token'),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/boom/);
    expect(logs.some((log) => log.message === 'minting the storage remote failed')).toBe(true);
  });
});
