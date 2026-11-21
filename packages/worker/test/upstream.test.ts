// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { clientHeaders, upstreamRequest } from '../src/proxy/upstream.ts';

const remote = {
  url: 'https://storage.test/git/site.git/',
  headers: { Authorization: 'Bearer minted' },
  expiresAt: null,
};

describe('upstreamRequest', () => {
  it('keeps only the protocol headers and replaces the credential', () => {
    const client = new Request('https://git.example.com/site.git/info/refs?service=git-receive-pack', {
      headers: {
        Authorization: 'Basic Y2xpZW50',
        Cookie: 'x',
        'Git-Protocol': 'version=2:object-format=sha1',
        'X-Forwarded-For': '1.2.3.4',
      },
    });
    const sent = upstreamRequest(
      client,
      { repo: 'site', endpoint: 'info-refs', service: 'git-receive-pack', operation: 'write' },
      remote,
      null,
    );
    expect(sent.url).toBe('https://storage.test/git/site.git/info/refs?service=git-receive-pack');
    expect(sent.redirect).toBe('manual');
    expect([...sent.headers.entries()].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ['authorization', 'Bearer minted'],
      ['git-protocol', 'object-format=sha1'],
    ]);
  });

  it('drops Content-Encoding on a push body (the gateway forwards it decompressed)', () => {
    const client = new Request('https://git.example.com/site.git/git-receive-pack', {
      method: 'POST',
      headers: { 'Content-Encoding': 'gzip' },
    });
    const sent = upstreamRequest(
      client,
      { repo: 'site', endpoint: 'receive-pack', service: 'git-receive-pack', operation: 'write' },
      remote,
      new Blob(['x']).stream(),
    );
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('Content-Encoding')).toBeNull();
  });
});

describe('clientHeaders', () => {
  it('passes the content type and caching headers and adds the request id', () => {
    const upstream = new Response('', {
      headers: {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Set-Cookie': 'a=b',
        'Content-Length': '0',
      },
    });
    const headers = clientHeaders(upstream, 'req-1');
    expect(headers.get('Content-Type')).toBe('application/x-git-upload-pack-result');
    expect(headers.get('Cache-Control')).toMatch(/no-cache/);
    expect(headers.get('Set-Cookie')).toBeNull();
    expect(headers.get('X-Request-Id')).toBe('req-1');
  });
});
