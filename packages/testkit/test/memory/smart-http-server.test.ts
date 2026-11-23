// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { arrayBufferBacked, concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { writePack } from '@leed-ai/git-gateway-core/pack/write-pack';
import { decodePktLines, packetText } from '@leed-ai/git-gateway-core/pkt-line/decode';
import { encodePktLine, FLUSH_PKT } from '@leed-ai/git-gateway-core/pkt-line/encode';
import { encodeReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/encode-request';
import { parseReportStatus } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { describe, expect, it } from 'vite-plus/test';

import { fixtureCommit } from '../../src/contract-suite/backend-fixtures.ts';
import { MemoryBackend } from '../../src/memory/memory-backend.ts';
import { credentialOf } from '../../src/memory/memory-tokens.ts';

const BASE = 'http://memory.git-gateway.invalid';

async function setup(name = 'repo'): Promise<{ backend: MemoryBackend; auth: string; readAuth: string }> {
  const backend = new MemoryBackend();
  await backend.createRepo(name);
  const auth = (await backend.gitRemote(name, 'write')).headers['Authorization'] ?? '';
  const readAuth = (await backend.gitRemote(name, 'read')).headers['Authorization'] ?? '';
  return { backend, auth, readAuth };
}

const post = (path: string, auth: string, body: Uint8Array, extra: Record<string, string> = {}): Request =>
  new Request(`${BASE}${path}`, { method: 'POST', headers: { Authorization: auth, ...extra }, body });

const lines = (bytes: Uint8Array): (string | null)[] => decodePktLines(bytes).map(packetText);

describe('in-memory smart-HTTP server', () => {
  it('answers 404 for unknown paths, 403 for dumb HTTP and 405 for wrong methods', async () => {
    const { backend, auth } = await setup();
    expect((await backend.handle(new Request(`${BASE}/nope`))).status).toBe(404);
    expect(
      (await backend.handle(new Request(`${BASE}/repo.git/info/refs`, { headers: { Authorization: auth } })))
        .status,
    ).toBe(403);
    expect(
      (
        await backend.handle(
          new Request(`${BASE}/repo.git/info/refs?service=git-upload-pack`, {
            method: 'POST',
            headers: { Authorization: auth },
            body: '',
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await backend.handle(
          new Request(`${BASE}/repo.git/git-upload-pack`, { headers: { Authorization: auth } }),
        )
      ).status,
    ).toBe(405);
  });

  it('asks for credentials, refuses tokens of other repositories, and refuses read tokens on receive-pack', async () => {
    const { backend, readAuth } = await setup();
    await backend.createRepo('other');
    const otherAuth = (await backend.gitRemote('other', 'write')).headers['Authorization'] ?? '';
    const anonymous = await backend.handle(new Request(`${BASE}/repo.git/info/refs?service=git-upload-pack`));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(
      (
        await backend.handle(
          new Request(`${BASE}/repo.git/info/refs?service=git-upload-pack`, {
            headers: { Authorization: otherAuth },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await backend.handle(
          new Request(`${BASE}/repo.git/info/refs?service=git-receive-pack`, {
            headers: { Authorization: readAuth },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await backend.handle(
          new Request(`${BASE}/repo.git/info/refs?service=git-upload-pack`, {
            headers: { Authorization: readAuth },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it('accepts the token as an HTTP Basic password, and expires and revokes tokens', async () => {
    let now = Date.parse('2026-11-20T00:00:00Z');
    const backend = new MemoryBackend({ now: () => new Date(now), tokenTtlSeconds: 60 });
    await backend.createRepo('repo');
    const token = ((await backend.gitRemote('repo', 'read')).headers['Authorization'] ?? '').slice(
      'Bearer '.length,
    );
    const basic = { Authorization: `Basic ${btoa(`anyone:${token}`)}` };
    const url = `${BASE}/repo.git/info/refs?service=git-upload-pack`;
    expect((await backend.handle(new Request(url, { headers: basic }))).status).toBe(200);
    now += 61_000;
    expect((await backend.handle(new Request(url, { headers: basic }))).status).toBe(401);
    const fresh = (await backend.gitRemote('repo', 'read')).headers['Authorization'] ?? '';
    await backend.deleteRepo('repo');
    expect((await backend.handle(new Request(url, { headers: { Authorization: fresh } }))).status).toBe(401);
  });

  it('reads gzip-compressed request bodies', async () => {
    const { backend, auth } = await setup();
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    const body = encodeReceivePackRequest({
      commands: [{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }],
      capabilities: ['report-status'],
      pack: await writePack(commit.objects),
    });
    const gzipped = new Uint8Array(
      await new Response(
        new Blob([arrayBufferBacked(body)]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );
    const response = await backend.handle(
      post('/repo.git/git-receive-pack', auth, gzipped, { 'Content-Encoding': 'gzip' }),
    );
    expect(
      parseReportStatus(new Uint8Array(await response.arrayBuffer()), { sideBand: 'none' }).refs,
    ).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
  });

  it('answers malformed receive-pack requests with ERR and corrupt packs with an unpack error', async () => {
    const { backend, auth } = await setup();
    const malformed = await backend.handle(
      post('/repo.git/git-receive-pack', auth, new TextEncoder().encode('zzzz')),
    );
    expect(lines(new Uint8Array(await malformed.arrayBuffer()))[0]).toMatch(/^ERR /);
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    const corrupt = encodeReceivePackRequest({
      commands: [{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }],
      capabilities: ['report-status'],
      pack: new TextEncoder().encode('PACK-not-really-a-pack-at-all-xxxx'),
    });
    const report = parseReportStatus(
      new Uint8Array(
        await (await backend.handle(post('/repo.git/git-receive-pack', auth, corrupt))).arrayBuffer(),
      ),
      { sideBand: 'none' },
    );
    expect(report.unpack).not.toBe('ok');
    expect(report.refs[0]).toMatchObject({ status: 'ng', reason: 'unpacker error' });
    const missingPack = concatBytes([
      encodePktLine(`${ZERO_SHA} ${commit.sha} refs/heads/main\0report-status\n`),
      FLUSH_PKT,
    ]);
    const noPack = parseReportStatus(
      new Uint8Array(
        await (await backend.handle(post('/repo.git/git-receive-pack', auth, missingPack))).arrayBuffer(),
      ),
      { sideBand: 'none' },
    );
    expect(noPack.unpack).not.toBe('ok');
  });

  it('refuses refs to missing objects, branches naming non-commits, no-op commands; applies atomic pushes all or nothing', async () => {
    const { backend, auth } = await setup();
    const client = new GitHttpClient(
      { url: `${BASE}/repo.git`, headers: { Authorization: auth } },
      { fetch: backend.fetch },
    );
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    const blob = await createObject('blob', new TextEncoder().encode('loose'));
    const missing = await client.push(
      [{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }],
      [commit.objects[0] ?? blob],
    );
    expect(missing.refs[0]).toMatchObject({ status: 'ng', reason: 'missing necessary objects' });
    const notCommit = await client.push(
      [{ oldSha: ZERO_SHA, newSha: blob.sha, ref: 'refs/heads/blob' }],
      [blob],
    );
    expect(notCommit.refs[0]).toMatchObject({ status: 'ng', reason: 'branch must point at a commit' });
    const noop = await client.push([{ oldSha: ZERO_SHA, newSha: ZERO_SHA, ref: 'refs/heads/none' }], []);
    expect(noop.refs[0]).toMatchObject({ status: 'ng', reason: 'nothing to do' });
    const atomic = await client.push(
      [
        { oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' },
        { oldSha: commit.sha, newSha: commit.sha, ref: 'refs/heads/stale' },
      ],
      commit.objects,
      { atomic: true },
    );
    expect(atomic.refs.map((ref) => ref.status)).toEqual(['ng', 'ng']);
    expect(atomic.refs[0]).toMatchObject({ reason: 'atomic transaction failed' });
    expect(await backend.resolveRef('repo', 'main')).toBeNull();
    const tagToBlob = await client.push(
      [{ oldSha: ZERO_SHA, newSha: blob.sha, ref: 'refs/tags/blob' }],
      [blob],
    );
    expect(tagToBlob.refs[0]?.status).toBe('ok');
  });

  it('answers without a report when report-status was not requested', async () => {
    const { backend, auth } = await setup();
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    const body = encodeReceivePackRequest({
      commands: [{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }],
      capabilities: [],
      pack: await writePack(commit.objects),
    });
    const response = await backend.handle(post('/repo.git/git-receive-pack', auth, body));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(await backend.resolveRef('repo', 'main')).toBe(commit.sha);
  });

  it('applies push options sections and parses the pack after them', async () => {
    const { backend, auth } = await setup();
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    const body = encodeReceivePackRequest({
      commands: [{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }],
      capabilities: ['report-status'],
      pushOptions: ['ci.skip'],
      pack: await writePack(commit.objects),
    });
    const report = parseReportStatus(
      new Uint8Array(
        await (await backend.handle(post('/repo.git/git-receive-pack', auth, body))).arrayBuffer(),
      ),
      { sideBand: 'none' },
    );
    expect(report.refs[0]?.status).toBe('ok');
  });

  it('refuses unknown wants and unsupported upload-pack lines, and frames packs for side-band and none', async () => {
    const { backend, auth } = await setup();
    const client = new GitHttpClient(
      { url: `${BASE}/repo.git`, headers: { Authorization: auth } },
      { fetch: backend.fetch },
    );
    const commit = await fixtureCommit({ 'a.txt': 'a\n' });
    await client.push([{ oldSha: ZERO_SHA, newSha: commit.sha, ref: 'refs/heads/main' }], commit.objects);
    const unknown = await backend.handle(
      post(
        '/repo.git/git-upload-pack',
        auth,
        concatBytes([encodePktLine(`want ${'f'.repeat(40)}\n`), FLUSH_PKT, encodePktLine('done\n')]),
      ),
    );
    expect(lines(new Uint8Array(await unknown.arrayBuffer()))[0]).toMatch(/^ERR upload-pack: not our ref/);
    const unsupported = await backend.handle(
      post(
        '/repo.git/git-upload-pack',
        auth,
        concatBytes([encodePktLine(`want ${commit.sha}\n`), encodePktLine('deepen-since 5\n'), FLUSH_PKT]),
      ),
    );
    expect(lines(new Uint8Array(await unsupported.arrayBuffer()))[0]).toMatch(/^ERR unsupported/);
    const sideBand = await client.fetchPack({ wants: [commit.sha], capabilities: ['side-band'] });
    expect(sideBand.objects).toHaveLength(commit.objects.length);
    const raw = await client.fetchPack({ wants: [commit.sha], capabilities: [] });
    expect(raw.objects).toHaveLength(commit.objects.length);
    const round = await backend.handle(
      post(
        '/repo.git/git-upload-pack',
        auth,
        concatBytes([
          encodePktLine(`want ${commit.sha}\n`),
          FLUSH_PKT,
          encodePktLine(`have ${commit.sha}\n`),
          FLUSH_PKT,
        ]),
      ),
    );
    expect(lines(new Uint8Array(await round.arrayBuffer()))).toEqual([`ACK ${commit.sha}`]);
  });
});

const withAuth = (value?: string): Request =>
  new Request(BASE, value === undefined ? {} : { headers: { Authorization: value } });

describe('credentialOf', () => {
  it('reads Bearer tokens and Basic passwords, and nothing else', () => {
    expect(credentialOf(withAuth('Bearer abc'))).toBe('abc');
    expect(credentialOf(withAuth(`Basic ${btoa('user:pa:ss')}`))).toBe('pa:ss');
    expect(credentialOf(withAuth(`Basic ${btoa('nocolon')}`))).toBeNull();
    expect(credentialOf(withAuth('Basic %%%'))).toBeNull();
    expect(credentialOf(withAuth('Digest x'))).toBeNull();
    expect(credentialOf(withAuth('Bearer'))).toBeNull();
    expect(credentialOf(withAuth())).toBeNull();
  });
});
