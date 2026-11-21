// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { describe, expect, it } from 'vite-plus/test';

import { basic, gatewayFixture, settle } from './helpers/gateway-fixture.ts';

describe('forwarding fetches', () => {
  it('proxies info/refs with a credential minted for the request, never the client one', async () => {
    const { app, upstream, backend, audits } = gatewayFixture();
    upstream.respond = () =>
      new Response('001e# service=git-upload-pack\n0000', {
        headers: {
          'Content-Type': 'application/x-git-upload-pack-advertisement',
          'Set-Cookie': 'session=upstream',
          'WWW-Authenticate': 'Basic realm="storage"',
          'X-Storage-Token': 'leak',
        },
      });
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: {
        ...basic('alice-token'),
        'User-Agent': 'git/2.43.0',
        Cookie: 'a=b',
        'Git-Protocol': 'version=2',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('001e# service=git-upload-pack\n0000');
    expect(response.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement');
    for (const name of ['Set-Cookie', 'WWW-Authenticate', 'X-Storage-Token'])
      expect(response.headers.get(name)).toBeNull();
    const sent = upstream.last();
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('https://storage.test/git/site.git/info/refs?service=git-upload-pack');
    expect(sent.headers.get('Authorization')).toBe('Bearer upstream-secret-1');
    expect(sent.headers.get('Cookie')).toBeNull();
    expect(sent.headers.get('User-Agent')).toBe('git/2.43.0');
    expect(sent.headers.get('Git-Protocol')).toBe('version=2');
    expect(backend.minted).toEqual([{ repo: 'site', access: 'read', token: 'upstream-secret-1' }]);
    await settle();
    expect(audits).toMatchObject([
      { outcome: 'allowed', operation: 'read', endpoint: 'info-refs', refs: [] },
    ]);
  });

  it('mints a fresh credential for every request', async () => {
    const { app, upstream } = gatewayFixture();
    await app.request('/site.git/info/refs?service=git-upload-pack', { headers: basic('alice-token') });
    await app.request('/site.git/git-upload-pack', {
      method: 'POST',
      headers: basic('alice-token'),
      body: '0000',
    });
    expect(upstream.received.map((request) => request.headers.get('Authorization'))).toEqual([
      'Bearer upstream-secret-1',
      'Bearer upstream-secret-2',
    ]);
  });

  it('streams an upload-pack request and response through untouched (protocol v2 passthrough)', async () => {
    const { app, upstream } = gatewayFixture();
    const request = new Uint8Array(70_000).map((_, index) => index % 251);
    const answer = new Uint8Array(200_000).map((_, index) => (index * 7) % 256);
    upstream.respond = () =>
      new Response(answer, { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
    const response = await app.request('/site.git/git-upload-pack', {
      method: 'POST',
      headers: {
        ...basic('alice-token'),
        'Content-Type': 'application/x-git-upload-pack-request',
        'Content-Encoding': 'gzip',
        'Git-Protocol': 'version=2',
        Accept: 'application/x-git-upload-pack-result',
      },
      body: request,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(answer);
    const sent = upstream.last();
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://storage.test/git/site.git/git-upload-pack');
    expect(sent.body).toEqual(request);
    expect(sent.headers.get('Content-Encoding')).toBe('gzip');
    expect(sent.headers.get('Git-Protocol')).toBe('version=2');
    expect(sent.headers.get('Content-Type')).toBe('application/x-git-upload-pack-request');
    expect(sent.headers.get('Accept')).toBe('application/x-git-upload-pack-result');
  });

  it.each([
    [404, 404, /Repository not found/],
    [401, 502, /failed to answer/],
    [403, 502, /failed to answer/],
    [500, 502, /failed to answer/],
    [302, 502, /failed to answer/],
  ])('maps a storage host %i to %i', async (status, expected, text) => {
    const { app, upstream, audits } = gatewayFixture();
    upstream.respond = () =>
      new Response('upstream detail', { status, headers: { Location: 'https://elsewhere.test/' } });
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('alice-token'),
    });
    expect(response.status).toBe(expected);
    const body = await response.text();
    expect(body).toMatch(text);
    expect(body).not.toMatch(/upstream detail/);
    await settle();
    expect(audits[0]?.outcome).toBe('failed');
  });

  it('answers 404 when the backend has no such repository, and 502 when it fails', async () => {
    const { app, backend } = gatewayFixture();
    expect(
      (await app.request('/missing.git/info/refs?service=git-upload-pack', { headers: basic('alice-token') }))
        .status,
    ).toBe(404);
    backend.failRemote = gatewayError('storage_unavailable', 'down', { retryable: true });
    expect(
      (await app.request('/site.git/info/refs?service=git-upload-pack', { headers: basic('alice-token') }))
        .status,
    ).toBe(502);
  });

  it('answers 502 when the storage host is unreachable', async () => {
    const { app, upstream, audits } = gatewayFixture();
    upstream.respond = () => {
      throw new TypeError('connection refused');
    };
    const response = await app.request('/site.git/info/refs?service=git-upload-pack', {
      headers: basic('alice-token'),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/unreachable/);
    await settle();
    expect(audits[0]?.outcome).toBe('failed');
  });
});
