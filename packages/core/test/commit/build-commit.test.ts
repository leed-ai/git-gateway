// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { buildCommit } from '../../src/commit/build-commit.ts';
import { decodeCommit } from '../../src/objects/commit-object.ts';
import type { BuildCommitInput } from '../../src/schemas/build-commit.ts';
import { MemoryStore, textFile } from '../helpers/memory-store.ts';

const ZERO = '0'.repeat(40);
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const GRACE = { name: 'Grace Hopper', email: 'grace@example.com' };
const DATE = '2026-11-20T09:30:00.500Z';

async function setup(): Promise<{ store: MemoryStore; base: { sha: string; tree: string } }> {
  const store = new MemoryStore();
  const tree = await store.writeSnapshot(new Map([['README.md', textFile('# Site\n')]]));
  return { store, base: { sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', tree } };
}

const input = (overrides: Partial<BuildCommitInput>): BuildCommitInput => ({
  branch: 'main',
  base: null,
  actions: [{ action: 'create', path: 'a.md', content: 'a' }],
  message: 'Add a',
  author: ADA,
  idempotencyKey: 'cms:1',
  date: DATE,
  ...overrides,
});

describe('buildCommit', () => {
  it('builds a commit on the base with the trailer, identities and whole-second date', async () => {
    const { store, base } = await setup();
    const built = await buildCommit(input({ base, committer: GRACE, message: 'Add a\n\n' }), store);
    if (built.status !== 'ready') throw new Error('expected a commit');
    expect(built.commit).toMatchObject({
      parents: [base.sha],
      author: { ...ADA, date: '2026-11-20T09:30:00.000Z' },
      committer: { ...GRACE, date: '2026-11-20T09:30:00.000Z' },
      message: 'Add a\n\nGateway-Idempotency-Key: cms:1\n',
      idempotencyKey: 'cms:1',
    });
    expect(built.refUpdate).toEqual({ ref: 'refs/heads/main', oldSha: base.sha, newSha: built.commit.sha });
    const last = built.objects.at(-1);
    expect(last?.type).toBe('commit');
    expect(decodeCommit(built.commit.sha, last?.data ?? new Uint8Array(0))).toEqual(built.commit);
    store.put(built.objects);
    expect([...(await store.flatten(built.commit.tree)).keys()]).toEqual(['README.md', 'a.md']);
  });

  it('makes the author the committer when none is given', async () => {
    const { store, base } = await setup();
    const built = await buildCommit(input({ base }), store);
    expect(built.status === 'ready' && built.commit.committer.name).toBe('Ada Lovelace');
  });

  it('builds a root commit on an empty repository, creating the branch', async () => {
    const built = await buildCommit(input({}), new MemoryStore());
    if (built.status !== 'ready') throw new Error('expected a commit');
    expect(built.commit.parents).toEqual([]);
    expect(built.refUpdate.oldSha).toBe(ZERO);
    expect(built.objects.map((object) => object.type)).toEqual(['blob', 'tree', 'commit']);
  });

  it('names a different old id when the branch starts from another branch', async () => {
    const { store, base } = await setup();
    const built = await buildCommit(input({ base, branch: 'feature/x', oldSha: null }), store);
    expect(built.status === 'ready' && built.refUpdate).toMatchObject({
      ref: 'refs/heads/feature/x',
      oldSha: ZERO,
    });
  });

  it('reports a no-op with the unchanged head', async () => {
    const { store, base } = await setup();
    const actions = [{ action: 'update' as const, path: 'README.md', content: '# Site\n' }];
    expect(await buildCommit(input({ base, actions }), store)).toEqual({ status: 'noop', head: base.sha });
    const empty = [
      { action: 'create' as const, path: 'x', content: '' },
      { action: 'delete' as const, path: 'x' },
    ];
    expect(await buildCommit(input({ actions: empty }), new MemoryStore())).toEqual({
      status: 'noop',
      head: null,
    });
  });

  it('throws the contract error for a broken action rule', async () => {
    const { store, base } = await setup();
    const error = await buildCommit(
      input({ base, actions: [{ action: 'delete', path: 'nope' }] }),
      store,
    ).catch((thrown: unknown) => thrown);
    expect(readGatewayError(error)?.code).toBe('path_not_found');
  });

  it('refuses invalid input', async () => {
    const store = new MemoryStore();
    await expect(buildCommit(input({ message: '   ' }), store)).rejects.toThrow(ZodError);
    await expect(buildCommit(input({ idempotencyKey: '' }), store)).rejects.toThrow(ZodError);
    await expect(buildCommit(input({ branch: 'refs/heads/main' }), store)).rejects.toThrow(ZodError);
  });
});
