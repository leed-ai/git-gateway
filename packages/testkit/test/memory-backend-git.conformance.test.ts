// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { MemoryBackend } from '../src/memory/memory-backend.ts';
import { serveFetchHandler, type LocalServer } from '../src/node/serve-fetch-handler.ts';
import { pseudoRandomBytes } from '../src/contract-suite/backend-fixtures.ts';
import { GitSandbox } from '../src/git-sandbox.ts';

// The in-memory backend's smart-HTTP server driven by the real git binary: clone, fetch, push,
// thin packs with deltas, branch create/delete, force and non-fast-forward, credential helpers.

const backend = new MemoryBackend();
const sandbox = new GitSandbox();
let server: LocalServer;

beforeAll(async () => {
  server = await serveFetchHandler(backend.handle);
  backend.setBaseUrl(server.url);
});

afterAll(async () => {
  await server.close();
  sandbox.dispose();
});

let counter = 0;

/** A new repository on the backend, and `-c` settings that authorize git against it. */
async function repository(
  access: 'read' | 'write' = 'write',
): Promise<{ name: string; url: string; auth: string[] }> {
  counter += 1;
  const name = `conformance-${counter}`;
  await backend.createRepo(name);
  const remote = await backend.gitRemote(name, access);
  return {
    name,
    url: remote.url,
    auth: [`http.extraHeader=Authorization: ${remote.headers['Authorization'] ?? ''}`],
  };
}

async function commitFile(
  dir: string,
  path: string,
  content: string | Uint8Array,
  message: string,
): Promise<string> {
  writeFileSync(`${dir}/${path}`, content);
  await sandbox.ok(['add', '-A'], { cwd: dir });
  await sandbox.ok(['commit', '-q', '-m', message], { cwd: dir });
  return await sandbox.ok(['rev-parse', 'HEAD'], { cwd: dir });
}

describe('in-memory backend with the git binary', () => {
  it('clones an empty repository, pushes to it and clones the result', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    const clone = await sandbox.run(['clone', repo.url, work], { config: repo.auth });
    expect(clone.status).toBe(0);
    expect(clone.stderr).toContain('empty repository');
    const head = await commitFile(work, 'README.md', '# Hello\n', 'Initial');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    expect(await backend.resolveRef(repo.name, 'main')).toBe(head);
    const copy = sandbox.path(`${repo.name}-copy`);
    await sandbox.ok(['clone', '-q', repo.url, copy], { config: repo.auth });
    expect(readFileSync(`${copy}/README.md`, 'utf8')).toBe('# Hello\n');
    await sandbox.ok(['fsck', '--strict'], { cwd: copy });
  });

  it('serves incremental fetches and thin-pack pushes with deltas', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    const big = Array.from({ length: 5000 }, (_, index) => `line ${index}: ${'x'.repeat(40)}`).join('\n');
    await commitFile(work, 'big.txt', `${big}\n`, 'Big file');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    const other = sandbox.path(`${repo.name}-other`);
    await sandbox.ok(['clone', '-q', repo.url, other], { config: repo.auth });
    // A one-line change: git sends it as a delta against the blob the server already has.
    const second = await commitFile(
      work,
      'big.txt',
      `${big.replace('line 2500:', 'line 2500 (edited):')}\n`,
      'Edit',
    );
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    expect(await backend.resolveRef(repo.name, 'main')).toBe(second);
    const file = await backend.readFile(repo.name, 'main', 'big.txt');
    expect(new TextDecoder().decode(file ?? new Uint8Array())).toContain('line 2500 (edited):');
    await sandbox.ok(['pull', '-q', '--ff-only'], { cwd: other, config: repo.auth });
    expect(await sandbox.ok(['rev-parse', 'HEAD'], { cwd: other })).toBe(second);
    await sandbox.ok(['fsck', '--strict'], { cwd: other });
  });

  it('creates and deletes branches, refuses non-fast-forwards without force, accepts force', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    const base = await commitFile(work, 'a.txt', 'a\n', 'A');
    await sandbox.ok(['push', '-q', 'origin', 'main', 'main:feature'], { cwd: work, config: repo.auth });
    expect(await backend.resolveRef(repo.name, 'feature')).toBe(base);
    await sandbox.ok(['push', '-q', 'origin', ':feature'], { cwd: work, config: repo.auth });
    expect(await backend.resolveRef(repo.name, 'feature')).toBeNull();
    await commitFile(work, 'b.txt', 'b\n', 'B');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    await sandbox.ok(['reset', '-q', '--hard', base], { cwd: work });
    const rewritten = await commitFile(work, 'c.txt', 'c\n', 'C');
    const refused = await sandbox.run(['push', 'origin', 'main'], { cwd: work, config: repo.auth });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/non-fast-forward|fetch first|rejected/);
    await sandbox.ok(['push', '-q', '--force', 'origin', 'main'], { cwd: work, config: repo.auth });
    expect(await backend.resolveRef(repo.name, 'main')).toBe(rewritten);
  });

  it('refuses a force-with-lease push whose lease is stale', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    const base = await commitFile(work, 'a.txt', 'a\n', 'A');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    const moved = await commitFile(work, 'b.txt', 'b\n', 'B');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    await sandbox.ok(['reset', '-q', '--hard', base], { cwd: work });
    await commitFile(work, 'c.txt', 'c\n', 'C');
    const stale = await sandbox.run(['push', `--force-with-lease=main:${base}`, 'origin', 'main'], {
      cwd: work,
      config: repo.auth,
    });
    expect(stale.status).not.toBe(0);
    expect(await backend.resolveRef(repo.name, 'main')).toBe(moved);
  });

  it('keeps large binary files, the executable bit and symbolic links', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    const bytes = pseudoRandomBytes(3 * 1024 * 1024);
    mkdirSync(`${work}/bin`);
    writeFileSync(`${work}/bin/run.sh`, '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync('bin/run.sh', `${work}/run`);
    await commitFile(work, 'blob.bin', bytes, 'Binary');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    expect(
      Buffer.from((await backend.readFile(repo.name, 'main', 'blob.bin')) ?? []).equals(Buffer.from(bytes)),
    ).toBe(true);
    const copy = sandbox.path(`${repo.name}-copy`);
    await sandbox.ok(['clone', '-q', repo.url, copy], { config: repo.auth });
    expect(statSync(`${copy}/bin/run.sh`).mode & 0o111).not.toBe(0);
    expect(await sandbox.ok(['ls-files', '-s', 'run'], { cwd: copy })).toMatch(/^120000 /);
    expect(Buffer.from(readFileSync(`${copy}/blob.bin`)).equals(Buffer.from(bytes))).toBe(true);
  });

  it('asks for credentials with a 401 and accepts the token from a credential helper', async () => {
    const repo = await repository();
    const token =
      (await backend.gitRemote(repo.name, 'read')).headers['Authorization']?.replace('Bearer ', '') ?? '';
    const unauthenticated = await sandbox.run(['ls-remote', repo.url]);
    expect(unauthenticated.status).not.toBe(0);
    const helper = `credential.helper=!f() { echo username=gateway; echo password=${token}; }; f`;
    expect((await sandbox.run(['ls-remote', repo.url], { config: [helper] })).status).toBe(0);
  });

  it('does not let a read credential push', async () => {
    const repo = await repository('read');
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await commitFile(work, 'a.txt', 'a\n', 'A');
    const pushed = await sandbox.run(['push', repo.url, 'main'], { cwd: work, config: repo.auth });
    expect(pushed.status).not.toBe(0);
    expect(await backend.resolveRef(repo.name, 'main')).toBeNull();
  });

  it('serves protocol v0 to clients that ask for protocol v2', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    await commitFile(work, 'a.txt', 'a\n', 'A');
    const head = await commitFile(work, 'b.txt', 'b\n', 'B');
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    const listed = await sandbox.ok(['ls-remote', repo.url], {
      config: [...repo.auth, 'protocol.version=2'],
    });
    expect(listed).toContain(`${head}\tHEAD`);
    expect(listed).toContain(`${head}\trefs/heads/main`);
  });

  it('serves shallow clones, deepens them by depth, and serves blob-less partial clones', async () => {
    const repo = await repository();
    const work = sandbox.path(`${repo.name}-work`);
    await sandbox.ok(['init', '-q', work]);
    await sandbox.ok(['remote', 'add', 'origin', repo.url], { cwd: work });
    for (const index of [1, 2, 3, 4]) await commitFile(work, `f${index}.txt`, `${index}\n`, `C${index}`);
    await sandbox.ok(['push', '-q', 'origin', 'main'], { cwd: work, config: repo.auth });
    const shallow = sandbox.path(`${repo.name}-shallow`);
    await sandbox.ok(['clone', '-q', '--depth', '1', repo.url, shallow], { config: repo.auth });
    expect(await sandbox.ok(['rev-list', '--count', 'HEAD'], { cwd: shallow })).toBe('1');
    expect(await sandbox.ok(['rev-parse', '--is-shallow-repository'], { cwd: shallow })).toBe('true');
    await sandbox.ok(['fetch', '-q', '--depth', '3'], { cwd: shallow, config: repo.auth });
    expect(await sandbox.ok(['rev-list', '--count', 'HEAD'], { cwd: shallow })).toBe('3');
    const partial = sandbox.path(`${repo.name}-partial`);
    await sandbox.ok(['clone', '-q', '--filter=blob:none', repo.url, partial], { config: repo.auth });
    expect(readFileSync(`${partial}/f4.txt`, 'utf8')).toBe('4\n');
    await sandbox.ok(['checkout', '-q', 'HEAD~2'], { cwd: partial, config: repo.auth });
    expect(readFileSync(`${partial}/f2.txt`, 'utf8')).toBe('2\n');
  });
});
