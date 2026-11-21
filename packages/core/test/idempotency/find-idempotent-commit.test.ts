// SPDX-License-Identifier: Apache-2.0
import { walkHistory } from '@leed-ai/git-gateway-contract/reference/history';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { findIdempotentCommit } from '../../src/idempotency/find-idempotent-commit.ts';
import { createCommit } from '../../src/objects/commit-object.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { MemoryStore } from '../helpers/memory-store.ts';

const NOW = '2026-11-20T12:00:00.000Z';
const WINDOW = { maxCommits: 200, maxAgeSeconds: 7 * 24 * 3600 };
const at = (minutesAgo: number): string => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();

async function commit(
  store: MemoryStore,
  parents: string[],
  minutesAgo: number,
  key?: string,
): Promise<Commit> {
  const signature = { name: 'Ada', email: 'ada@example.com', date: at(minutesAgo) };
  const message =
    key === undefined ? `change ${minutesAgo}\n` : `change\n\nGateway-Idempotency-Key: ${key}\n`;
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

/** A linear history, oldest first, one commit a minute; `keys[i]` is the key of the i-th commit. */
async function linear(store: MemoryStore, keys: (string | undefined)[]): Promise<Commit[]> {
  const commits: Commit[] = [];
  for (const [index, key] of keys.entries()) {
    const parent = commits.at(-1);
    commits.push(await commit(store, parent === undefined ? [] : [parent.sha], keys.length - index, key));
  }
  return commits;
}

describe('findIdempotentCommit', () => {
  it('finds the commit carrying the key', async () => {
    const store = new MemoryStore();
    const history = await linear(store, ['k1', undefined, 'k2', undefined]);
    const head = history.at(-1)?.sha ?? '';
    expect(await findIdempotentCommit({ head, key: 'k1', window: WINDOW, now: NOW }, store)).toEqual(
      history[0],
    );
    expect(await findIdempotentCommit({ head, key: 'k2', window: WINDOW, now: NOW }, store)).toEqual(
      history[2],
    );
    expect(await findIdempotentCommit({ head, key: 'k3', window: WINDOW, now: NOW }, store)).toBeNull();
  });

  it('finds the head itself', async () => {
    const store = new MemoryStore();
    const [only] = await linear(store, ['k']);
    expect(
      await findIdempotentCommit({ head: only?.sha ?? '', key: 'k', window: WINDOW, now: NOW }, store),
    ).toEqual(only);
  });

  it('examines at most maxCommits commits', async () => {
    const store = new MemoryStore();
    const history = await linear(store, ['old', undefined, undefined]);
    const head = history.at(-1)?.sha ?? '';
    const lookup = (maxCommits: number) =>
      findIdempotentCommit(
        { head, key: 'old', window: { maxCommits, maxAgeSeconds: 3600 }, now: NOW },
        store,
      );
    expect(await lookup(2)).toBeNull();
    expect(await lookup(3)).toEqual(history[0]);
  });

  it('stops at the first commit older than maxAgeSeconds', async () => {
    const store = new MemoryStore();
    const old = await commit(store, [], 120, 'k');
    const head = await commit(store, [old.sha], 1);
    const lookup = (maxAgeSeconds: number) =>
      findIdempotentCommit(
        { head: head.sha, key: 'k', window: { maxCommits: 10, maxAgeSeconds }, now: NOW },
        store,
      );
    expect(await lookup(60 * 60)).toBeNull();
    expect(await lookup(3 * 60 * 60)).toEqual(old);
  });

  it('applies the default window', async () => {
    const store = new MemoryStore();
    const [only] = await linear(store, ['k']);
    expect(
      await findIdempotentCommit({ head: only?.sha ?? '', key: 'k', window: {}, now: NOW }, store),
    ).toEqual(only);
  });

  it('follows both parents of a merge, newest first', async () => {
    const store = new MemoryStore();
    const root = await commit(store, [], 10);
    const left = await commit(store, [root.sha], 8, 'left');
    const right = await commit(store, [root.sha], 6, 'right');
    const merge = await commit(store, [left.sha, right.sha], 2);
    const lookup = (key: string, maxCommits: number) =>
      findIdempotentCommit(
        { head: merge.sha, key, window: { maxCommits, maxAgeSeconds: 3600 }, now: NOW },
        store,
      );
    expect(await lookup('right', 2)).toEqual(right);
    expect(await lookup('left', 2)).toBeNull();
    expect(await lookup('left', 3)).toEqual(left);
  });

  it('skips parents the reader does not have', async () => {
    const store = new MemoryStore();
    const head = await commit(store, ['9'.repeat(40)], 1);
    expect(
      await findIdempotentCommit({ head: head.sha, key: 'k', window: WINDOW, now: NOW }, store),
    ).toBeNull();
  });

  it('reports a head the reader does not have', async () => {
    const error = await findIdempotentCommit(
      { head: '9'.repeat(40), key: 'k', window: WINDOW, now: NOW },
      new MemoryStore(),
    ).catch((thrown: unknown) => thrown);
    expect(isCoreError(error, 'missing_object')).toBe(true);
  });

  it('reports a reader that returns an invalid commit', async () => {
    const reader = { readCommit: async (): Promise<Commit> => JSON.parse('{"sha":"nope"}') };
    const error = await findIdempotentCommit(
      { head: '9'.repeat(40), key: 'k', window: WINDOW, now: NOW },
      reader,
    ).catch((thrown: unknown) => thrown);
    expect(isCoreError(error, 'invalid_object')).toBe(true);
  });

  it('refuses invalid input', async () => {
    await expect(
      findIdempotentCommit({ head: 'x', key: 'k', window: WINDOW, now: NOW }, new MemoryStore()),
    ).rejects.toThrow(ZodError);
    await expect(
      findIdempotentCommit(
        { head: '9'.repeat(40), key: 'bad key', window: WINDOW, now: NOW },
        new MemoryStore(),
      ),
    ).rejects.toThrow(ZodError);
  });

  it('agrees with the contract reference window on linear histories', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(fc.constantFrom('a', 'b', 'c'), { nil: undefined }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.integer({ min: 1, max: 12 }),
        fc.constantFrom('a', 'b', 'c'),
        async (keys, maxCommits, key) => {
          const store = new MemoryStore();
          const history = await linear(store, keys);
          const head = history.at(-1)?.sha ?? '';
          const window = walkHistory((sha) => store.commits.get(sha), head).slice(0, maxCommits);
          const expected = window.find((c) => c.idempotencyKey === key) ?? null;
          const found = await findIdempotentCommit(
            { head, key, window: { maxCommits, maxAgeSeconds: 3600 }, now: NOW },
            store,
          );
          expect(found).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
