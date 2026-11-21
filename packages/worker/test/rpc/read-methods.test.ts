// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { memoryGateway, seed, write } from '../helpers/memory-gateway.ts';

const REPO = 'reads';

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  throw new Error('expected the call to fail');
}

/** A backend whose blobs have gone missing, as a damaged store would behave. */
class LostBlobsBackend extends MemoryBackend {
  override async readBlob(): Promise<Uint8Array | null> {
    return null;
  }
}

/** A backend whose trees come back malformed. */
class GarbledTreesBackend extends MemoryBackend {
  garble = false;

  override async readTree(name: string, sha: string): Promise<StorageTreeEntry[] | null> {
    const entries = await super.readTree(name, sha);
    return this.garble ? (entries ?? []).map((entry) => ({ ...entry, sha: 'not-a-sha' })) : entries;
  }
}

describe('reads over git', () => {
  it('reads a file at a branch and at a commit id, with blob id, size and mode', async () => {
    const { gateway } = memoryGateway();
    const first = await seed(gateway, REPO, { 'dir/a.md': 'one' });
    await write(gateway, REPO, 'main', { 'dir/a.md': 'two!' });
    expect(await gateway.readFile({ repo: REPO, ref: first, path: 'dir/a.md' })).toMatchObject({
      commit: first,
      size: 3,
      executable: false,
      encoding: 'text',
      content: 'one',
    });
    expect((await gateway.readFile({ repo: REPO, ref: 'main', path: 'dir/a.md' }))?.content).toBe('two!');
  });

  it('returns null for a directory, a missing path, or a path beneath a file', async () => {
    const { gateway } = memoryGateway();
    await seed(gateway, REPO, { 'dir/a.md': 'one' });
    for (const path of ['dir', 'nope.md', 'dir/a.md/below']) {
      expect(await gateway.readFile({ repo: REPO, ref: 'main', path })).toBeNull();
    }
  });

  it('lists one level or every level, sorted by full path in byte order', async () => {
    const { gateway } = memoryGateway();
    await seed(gateway, REPO, { 'a/b.md': 'b', 'a.md': 'a', 'a-z.md': 'z', 'a/c/d.md': 'd' });
    const top = await gateway.listTree({ repo: REPO, ref: 'main' });
    expect(top?.entries.map((entry) => entry.path)).toEqual(['a', 'a-z.md', 'a.md']);
    const all = await gateway.listTree({ repo: REPO, ref: 'main', path: 'a', recursive: true });
    expect(all?.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['a/b.md', 'blob'],
      ['a/c', 'tree'],
      ['a/c/d.md', 'blob'],
    ]);
    expect(await gateway.listTree({ repo: REPO, ref: 'main', path: 'a.md' })).toBeNull();
    expect(await gateway.listTree({ repo: REPO, ref: 'main', path: 'missing' })).toBeNull();
  });

  it('resolves branches and commit ids, and null for anything else', async () => {
    const { gateway } = memoryGateway();
    const head = await seed(gateway, REPO);
    const tree = (await gateway.log({ repo: REPO, ref: 'main' })).commits[0]?.tree ?? '';
    expect(await gateway.resolveRef({ repo: REPO, ref: 'main' })).toEqual({ sha: head });
    expect(await gateway.resolveRef({ repo: REPO, ref: head })).toEqual({ sha: head });
    expect(await gateway.resolveRef({ repo: REPO, ref: tree })).toBeNull();
    expect(await gateway.resolveRef({ repo: REPO, ref: 'nope' })).toBeNull();
  });

  it('pages history and filters it by committer date', async () => {
    let now = Date.parse('2026-11-01T00:00:00.000Z');
    const { gateway } = memoryGateway({ now: () => new Date((now += 60_000)) });
    await seed(gateway, REPO);
    for (const name of ['a', 'b', 'c']) await write(gateway, REPO, 'main', { [`${name}.md`]: name });
    const page = await gateway.log({ repo: REPO, ref: 'main', limit: 2, offset: 1 });
    expect(page.commits).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const all = await gateway.log({ repo: REPO, ref: 'main' });
    const since = all.commits[1]?.committer.date;
    const recent = await gateway.log({ repo: REPO, ref: 'main', since });
    expect(recent.commits.map((commit) => commit.sha)).toEqual(
      all.commits.slice(0, 2).map((commit) => commit.sha),
    );
  });

  it('reports a commit as on a branch only when reachable from it', async () => {
    const { gateway } = memoryGateway();
    const head = await seed(gateway, REPO);
    const feature = await write(gateway, REPO, 'feature', { 'f.md': 'f' }, { startBranch: 'main' });
    expect(await gateway.commitExists({ repo: REPO, sha: feature })).toEqual({ exists: true });
    expect(await gateway.commitExists({ repo: REPO, sha: feature, branch: 'main' })).toEqual({
      exists: false,
    });
    expect(await gateway.commitExists({ repo: REPO, sha: head, branch: 'feature' })).toEqual({
      exists: true,
    });
    expect(await gateway.commitExists({ repo: REPO, sha: head, branch: 'gone' })).toEqual({ exists: false });
    expect(await gateway.commitExists({ repo: REPO, sha: '0'.repeat(40) })).toEqual({ exists: false });
  });

  it('reports storage_unavailable when the store has lost a blob a tree names', async () => {
    const backend = new LostBlobsBackend();
    const { gateway } = memoryGateway({}, backend);
    await seed(gateway, REPO);
    expect(await errorOf(gateway.readFile({ repo: REPO, ref: 'main', path: 'README.md' }))).toMatchObject({
      code: 'storage_unavailable',
    });
  });

  it('reports storage_unavailable when the store hands back malformed objects', async () => {
    const backend = new GarbledTreesBackend();
    const { gateway } = memoryGateway({}, backend);
    await seed(gateway, REPO, { 'dir/a.md': 'a' });
    backend.garble = true;
    const error = await errorOf(write(gateway, REPO, 'main', { 'dir/b.md': 'b' }));
    expect(error).toMatchObject({ code: 'storage_unavailable', details: { retryable: true } });
  });

  it('answers every method on a missing repository with repo_not_found, except deleteRepo', async () => {
    const { gateway } = memoryGateway();
    const repo = 'missing';
    for (const call of [
      gateway.readFile({ repo, ref: 'main', path: 'a.md' }),
      gateway.listTree({ repo, ref: 'main' }),
      gateway.resolveRef({ repo, ref: 'main' }),
      gateway.log({ repo, ref: 'main' }),
      gateway.commitExists({ repo, sha: '0'.repeat(40) }),
      gateway.syncBranch({ repo, from: 'main', into: 'staging' }),
    ]) {
      expect((await errorOf(call))?.code).toBe('repo_not_found');
    }
    expect(await gateway.deleteRepo({ repo })).toEqual({ deleted: false });
  });

  it('fills in a creation time when the host reports none', async () => {
    class NoDatesBackend extends MemoryBackend {
      override async createRepo(name: string) {
        return { ...(await super.createRepo(name)), createdAt: null };
      }
    }
    const now = new Date('2026-11-20T00:00:00.000Z');
    const { gateway } = memoryGateway({ now: () => now }, new NoDatesBackend());
    expect((await gateway.createRepo({ repo: REPO })).createdAt).toBe(now.toISOString());
  });
});
