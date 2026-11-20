// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import { writePack } from '../../src/pack/write-pack.ts';
import { decodePktLines, packetText } from '../../src/pkt-line/decode.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import { encodeReportStatus } from '../../src/receive-pack/report-status.ts';
import { encodeSideBand } from '../../src/receive-pack/side-band.ts';
import { GitHttpClient } from '../../src/smart-http/git-http-client.ts';
import { encodeRefAdvertisement } from '../../src/smart-http/ref-advertisement.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const ZERO = '0'.repeat(40);
const REMOTE = { url: 'https://git.example.com/acme.git', headers: { Authorization: 'Bearer secret' } };

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** A fake server answering by path, recording every request. */
function fakeServer(answers: Record<string, () => Response | Promise<Response>>): {
  seen: Seen[];
  fetch: (request: Request) => Promise<Response>;
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      const answer = answers[`${url.pathname}${url.search}`];
      return answer === undefined ? new Response('missing', { status: 404 }) : answer();
    },
  };
}

const receiveAdvertisement = (capabilities: string[]): Response =>
  new Response(encodeRefAdvertisement({ service: 'git-receive-pack', refs: [], capabilities, symrefs: {} }));

describe('GitHttpClient', () => {
  it('reads an advertisement with the remote headers and a git user agent', async () => {
    const server = fakeServer({
      '/acme.git/info/refs?service=git-upload-pack': () =>
        new Response(
          encodeRefAdvertisement({
            service: 'git-upload-pack',
            refs: [{ name: 'refs/heads/main', sha: A, peeled: null }],
            capabilities: [],
            symrefs: {},
          }),
        ),
    });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch, userAgent: 'git/2.50.0 (test)' });
    expect((await client.advertisement('git-upload-pack')).refs).toHaveLength(1);
    expect(server.seen[0]?.headers.get('Authorization')).toBe('Bearer secret');
    expect(server.seen[0]?.headers.get('User-Agent')).toBe('git/2.50.0 (test)');
  });

  it('pushes commands and a pack, asking only for advertised capabilities, and reads the report', async () => {
    const blob = await createObject('blob', new TextEncoder().encode('x'));
    const server = fakeServer({
      '/acme.git/info/refs?service=git-receive-pack': () =>
        receiveAdvertisement(['report-status', 'side-band-64k', 'atomic']),
      '/acme.git/git-receive-pack': () =>
        new Response(
          encodeReportStatus(
            { unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] },
            { sideBand: 'side-band-64k' },
          ),
        ),
    });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
    const report = await client.push([{ oldSha: ZERO, newSha: A, ref: 'refs/heads/main' }], [blob], {
      atomic: true,
    });
    expect(report).toEqual({ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] });
    const post = server.seen[1];
    expect(post?.headers.get('Content-Type')).toBe('application/x-git-receive-pack-request');
    const body = post?.body ?? new Uint8Array();
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
    const first = packetText(decodePktLines(body.subarray(0, length)).at(0) ?? { type: 'flush' });
    expect(first).toBe(`${ZERO} ${A} refs/heads/main\0report-status side-band-64k atomic`);
    expect(new TextDecoder().decode(post?.body).includes('PACK')).toBe(true);
  });

  it('sends no pack for a push of deletes only, and drops capabilities the server lacks', async () => {
    const server = fakeServer({
      '/acme.git/info/refs?service=git-receive-pack': () => receiveAdvertisement(['report-status']),
      '/acme.git/git-receive-pack': () =>
        new Response(
          encodeReportStatus(
            { unpack: 'ok', refs: [{ ref: 'refs/heads/x', status: 'ok' }] },
            { sideBand: 'none' },
          ),
        ),
    });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
    await client.push([{ oldSha: A, newSha: ZERO, ref: 'refs/heads/x' }], [], { atomic: true });
    const body = new TextDecoder().decode(server.seen[1]?.body);
    expect(body).toContain('\0report-status\n');
    expect(body.endsWith('0000')).toBe(true);
    expect(body).not.toContain('PACK');
  });

  it('fetches a pack and reads its objects', async () => {
    const blob = await createObject('blob', new TextEncoder().encode('fetched'));
    const pack = await writePack([blob]);
    const server = fakeServer({
      '/acme.git/git-upload-pack': () =>
        new Response(
          concatBytes([
            encodePktLine(`shallow ${A}\n`),
            FLUSH_PKT,
            encodePktLine('NAK\n'),
            encodeSideBand(1, pack),
            FLUSH_PKT,
          ]),
        ),
    });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
    const fetched = await client.fetchPack({ wants: [blob.sha], depth: 1 });
    expect(fetched.objects).toEqual([blob]);
    expect(fetched.response.shallow).toEqual([A]);
    expect(server.seen[0]?.headers.get('Content-Type')).toBe('application/x-git-upload-pack-request');
  });

  it('returns no objects when the answer carries no pack, and reads raw packs without side-band', async () => {
    const blob = await createObject('blob', new TextEncoder().encode('raw'));
    const pack = await writePack([blob]);
    let answer = concatBytes([encodePktLine('NAK\n')]);
    const server = fakeServer({ '/acme.git/git-upload-pack': () => new Response(answer) });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
    expect((await client.fetchPack({ wants: [blob.sha] })).objects).toEqual([]);
    answer = concatBytes([encodePktLine('NAK\n'), pack]);
    expect((await client.fetchPack({ wants: [blob.sha], capabilities: [] })).objects).toEqual([blob]);
  });

  it('throws remote_http_error carrying the status for an HTTP failure, without the credential', async () => {
    const client = new GitHttpClient(REMOTE, { fetch: fakeServer({}).fetch });
    let thrown: unknown;
    try {
      await client.advertisement('git-upload-pack');
    } catch (error) {
      thrown = error;
    }
    expect(isCoreError(thrown, 'remote_http_error') && thrown.body.details).toEqual({
      status: 404,
      path: '/acme.git/info/refs',
    });
    expect(String(thrown)).toContain('HTTP 404');
    expect(String(thrown)).not.toContain('secret');
  });

  it('throws remote_http_error on fetch and push POSTs too, with the service path and no credential', async () => {
    for (const status of [401, 403, 500, 502, 503]) {
      const server = fakeServer({
        '/acme.git/git-upload-pack': () => new Response('upstream failure', { status }),
        '/acme.git/info/refs?service=git-receive-pack': () => receiveAdvertisement(['report-status']),
        '/acme.git/git-receive-pack': () => new Response('upstream failure', { status }),
      });
      const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
      const fetchError = await client.fetchPack({ wants: [A] }).catch((error: unknown) => error);
      expect(isCoreError(fetchError, 'remote_http_error') && fetchError.body.details).toEqual({
        status,
        path: '/acme.git/git-upload-pack',
      });
      const pushError = await client
        .push([{ oldSha: A, newSha: ZERO, ref: 'refs/heads/gone' }], [])
        .catch((error: unknown) => error);
      expect(isCoreError(pushError, 'remote_http_error') && pushError.body.details).toEqual({
        status,
        path: '/acme.git/git-receive-pack',
      });
      for (const error of [fetchError, pushError]) {
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  it('keeps an in-protocol ERR in an HTTP 200 answer as remote_error, distinct from an HTTP failure', async () => {
    const server = fakeServer({
      '/acme.git/git-upload-pack': () =>
        new Response(concatBytes([encodePktLine(`ERR upload-pack: not our ref ${A}\n`)])),
    });
    const client = new GitHttpClient(REMOTE, { fetch: server.fetch });
    const error = await client.fetchPack({ wants: [A] }).catch((thrown: unknown) => thrown);
    expect(isCoreError(error, 'remote_error')).toBe(true);
    expect(isCoreError(error, 'remote_http_error')).toBe(false);
  });

  it('maps every non-2xx status to remote_http_error carrying exactly that status (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 300, max: 599 }), async (status) => {
        const body = status === 304 ? null : 'nope';
        const client = new GitHttpClient(REMOTE, {
          fetch: async () => new Response(body, { status }),
        });
        const error = await client.advertisement('git-receive-pack').catch((thrown: unknown) => thrown);
        expect(isCoreError(error, 'remote_http_error') && error.body.details).toEqual({
          status,
          path: '/acme.git/info/refs',
        });
        expect(String(error)).not.toContain('secret');
      }),
    );
  });

  it('uses the global fetch by default', () => {
    expect(new GitHttpClient(REMOTE)).toBeInstanceOf(GitHttpClient);
  });
});
