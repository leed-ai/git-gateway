// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { describe, expect, it } from 'vite-plus/test';

import { findIdempotentCommit } from '../../src/idempotency/find-idempotent-commit.ts';
import { createCommit } from '../../src/objects/commit-object.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { MemoryStore } from '../helpers/memory-store.ts';

const NOW = '2026-11-20T12:00:00.000Z';
const at = (secondsAgo: number): string => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();

async function commit(
  store: MemoryStore,
  parents: string[],
  secondsAgo: number,
  key?: string,
): Promise<Commit> {
  const signature = { name: 'Ada', email: 'ada@example.com', date: at(secondsAgo) };
  const message =
    key === undefined ? `change ${secondsAgo}\n` : `change\n\nGateway-Idempotency-Key: ${key}\n`;
  const { commit: created } = await createCommit({
    tree: EMPTY_TREE_SHA,
    parents,
    author: signature,
    committer: signature,
    message,
  });
  store.putCommit(created);
  return created;
}

/** A store that counts how often each commit is read. */
class CountingStore extends MemoryStore {
  readonly reads: string[] = [];

  override async readCommit(sha: string): Promise<Commit | null> {
    this.reads.push(sha);
    return super.readCommit(sha);
  }
}

describe('findIdempotentCommit window edges', () => {
  it('includes a commit exactly maxAgeSeconds old and excludes one a second older', async () => {
    const store = new MemoryStore();
    const edge = await commit(store, [], 600, 'edge');
    const head = await commit(store, [edge.sha], 0);
    const lookup = (maxAgeSeconds: number) =>
      findIdempotentCommit(
        { head: head.sha, key: 'edge', window: { maxCommits: 10, maxAgeSeconds }, now: NOW },
        store,
      );
    expect(await lookup(600)).toEqual(edge);
    expect(await lookup(599)).toBeNull();
  });

  it('examines only the head when maxCommits is 1', async () => {
    const store = new MemoryStore();
    const parent = await commit(store, [], 10, 'k');
    const head = await commit(store, [parent.sha], 5);
    expect(
      await findIdempotentCommit(
        { head: head.sha, key: 'k', window: { maxCommits: 1, maxAgeSeconds: 3600 }, now: NOW },
        store,
      ),
    ).toBeNull();
  });

  it('reads a common ancestor of a merge only once', async () => {
    const store = new CountingStore();
    const root = await commit(store, [], 100);
    const left = await commit(store, [root.sha], 80);
    const right = await commit(store, [root.sha], 60);
    const merge = await commit(store, [left.sha, right.sha], 10);
    expect(
      await findIdempotentCommit(
        { head: merge.sha, key: 'absent', window: { maxCommits: 50, maxAgeSeconds: 3600 }, now: NOW },
        store,
      ),
    ).toBeNull();
    expect(store.reads.filter((sha) => sha === root.sha)).toHaveLength(1);
  });

  it('finds the newest of two commits that carry the same key', async () => {
    const store = new MemoryStore();
    const older = await commit(store, [], 50, 'dup');
    const newer = await commit(store, [older.sha], 20, 'dup');
    const head = await commit(store, [newer.sha], 1);
    expect(
      await findIdempotentCommit(
        { head: head.sha, key: 'dup', window: { maxCommits: 10, maxAgeSeconds: 3600 }, now: NOW },
        store,
      ),
    ).toEqual(newer);
  });

  it('does not match a key that only prefixes the trailer value', async () => {
    const store = new MemoryStore();
    const head = await commit(store, [], 1, 'abc-123');
    expect(
      await findIdempotentCommit(
        { head: head.sha, key: 'abc', window: { maxCommits: 10, maxAgeSeconds: 3600 }, now: NOW },
        store,
      ),
    ).toBeNull();
  });

  it('returns null for a head older than the window', async () => {
    const store = new MemoryStore();
    const head = await commit(store, [], 7200, 'k');
    expect(
      await findIdempotentCommit(
        { head: head.sha, key: 'k', window: { maxCommits: 10, maxAgeSeconds: 3600 }, now: NOW },
        store,
      ),
    ).toBeNull();
  });
});
