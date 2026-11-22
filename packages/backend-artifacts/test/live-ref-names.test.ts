// SPDX-License-Identifier: Apache-2.0
import { createCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { describe, expect, it } from 'vite-plus/test';

import { ArtifactsBackend, bindingRef } from '../src/artifacts-backend.ts';
import { fakeBinding, fakeHandle } from './helpers/fake-binding.ts';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SIGNATURE = { name: 'Ada', email: 'ada@example.com', date: '2026-11-20T09:30:00.000Z' };
const SECONDS = Date.parse(SIGNATURE.date) / 1000;

/**
 * A repository handle that resolves refs the way the live Artifacts binding was observed to, on a
 * repository with one commit on main: log({ ref: "main" }) and log({}) list the commit, while
 * log({ ref: "refs/heads/main" }) and log({ ref: "HEAD" }) list nothing; readFile likewise. (The
 * local simulator the contract suite runs against also accepts full ref names, which is how
 * passing full names went unnoticed.)
 */
async function liveLikeBackend() {
  const { object } = await createCommit({
    tree: TREE,
    parents: [],
    author: SIGNATURE,
    committer: SIGNATURE,
    message: 'Seed\n',
  });
  const metadata = {
    hash: object.sha,
    treeHash: TREE,
    message: 'Seed',
    author: { name: 'Ada', email: 'ada@example.com' },
    committer: { name: 'Ada', email: 'ada@example.com' },
    parents: [],
    authoredAt: SECONDS,
    committedAt: SECONDS,
  };
  const resolves = (ref: string | undefined) => ref === undefined || ref === 'main' || ref === object.sha;
  const handle = fakeHandle({
    log: async (opts) => (resolves(opts?.ref) ? [metadata] : []),
    readFile: async ({ ref, path }) => (resolves(ref) && path === 'a.md' ? new Blob(['A']) : null),
  });
  return { sha: object.sha, backend: new ArtifactsBackend({ binding: fakeBinding(handle) }) };
}

describe('ref names against the live binding', () => {
  it('resolves a branch by its short and its full name', async () => {
    const { sha, backend } = await liveLikeBackend();
    expect(await backend.resolveRef('acme', 'main')).toBe(sha);
    expect(await backend.resolveRef('acme', 'refs/heads/main')).toBe(sha);
    expect(await backend.resolveRef('acme', 'refs/heads/other')).toBeNull();
  });

  it('reads history and files at a branch', async () => {
    const { sha, backend } = await liveLikeBackend();
    expect((await backend.log('acme', 'main', { limit: 1 })).map((commit) => commit.sha)).toEqual([sha]);
    expect(await backend.readFile('acme', 'main', 'a.md')).toEqual(new TextEncoder().encode('A'));
    expect(await backend.readFile('acme', sha, 'a.md')).toEqual(new TextEncoder().encode('A'));
  });

  it('drops only a leading refs/heads/ or refs/tags/', () => {
    expect(bindingRef('refs/heads/feature/refs/heads/x')).toBe('feature/refs/heads/x');
    expect(bindingRef('refs/tags/v1.0.0')).toBe('v1.0.0');
    expect(bindingRef('main')).toBe('main');
  });
});
