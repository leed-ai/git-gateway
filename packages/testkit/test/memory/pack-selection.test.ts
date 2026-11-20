// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { fixtureCommit, type FixtureCommit } from '../../src/contract-suite/backend-fixtures.ts';
import { MemoryRepository } from '../../src/memory/memory-repository.ts';
import { selectPack } from '../../src/memory/pack-selection.ts';

/** A repository holding a chain of four commits on main, each adding one file under dir/. */
async function chain(): Promise<{ repo: MemoryRepository; commits: FixtureCommit[] }> {
  const repo = new MemoryRepository('r', 'main', '2026-11-20T00:00:00.000Z');
  const commits: FixtureCommit[] = [];
  const files: Record<string, string | { content: Uint8Array }> = {};
  for (let index = 0; index < 4; index += 1) {
    files[`dir/f${index}.txt`] = `${index}\n`.repeat(index * 100 + 1);
    const commit = await fixtureCommit({ ...files }, commits.length === 0 ? [] : [commits.at(-1)?.sha ?? '']);
    repo.put(commit.objects);
    commits.push(commit);
  }
  repo.refs.set('refs/heads/main', commits.at(-1)?.sha ?? '');
  return { repo, commits };
}

const kinds = (objects: readonly { type: string }[]): Record<string, number> =>
  objects.reduce<Record<string, number>>(
    (counts, object) => ({ ...counts, [object.type]: (counts[object.type] ?? 0) + 1 }),
    {},
  );

describe('selectPack', () => {
  it('sends everything reachable without a cut or filter', async () => {
    const { repo, commits } = await chain();
    const selected = selectPack(repo, { wants: [commits[3]?.sha ?? ''], haves: [] });
    expect(kinds(selected.objects)).toEqual({ commit: 4, tree: 8, blob: 4 });
    expect(selected.shallow).toEqual([]);
  });

  it('cuts history at the deepen and reports the boundary', async () => {
    const { repo, commits } = await chain();
    const selected = selectPack(repo, { wants: [commits[3]?.sha ?? ''], haves: [], depth: 2 });
    expect(kinds(selected.objects)['commit']).toBe(2);
    expect(selected.shallow).toEqual([commits[2]?.sha]);
  });

  it('deepens a shallow client: unshallows its old boundary and leaves out what it has', async () => {
    const { repo, commits } = await chain();
    const tip = commits[3]?.sha ?? '';
    const selected = selectPack(repo, { wants: [tip], haves: [tip], clientShallow: [tip], depth: 3 });
    expect(selected.unshallow).toEqual([tip]);
    expect(selected.shallow).toEqual([commits[1]?.sha]);
    expect(selected.objects.map((object) => object.sha)).not.toContain(tip);
    expect(selected.objects.map((object) => object.sha)).toContain(commits[2]?.sha);
  });

  it('leaves out a blob whose size equals the blob:limit, as git does', async () => {
    const { repo, commits } = await chain();
    const want = [commits[3]?.sha ?? ''];
    // Blob sizes are 2, 202, 402 and 602 bytes; git keeps a blob only when its size is below the limit.
    const blobs = (filter: string): number | undefined =>
      kinds(selectPack(repo, { wants: want, haves: [], filter }).objects)['blob'];
    expect(blobs('blob:limit=202')).toBe(1);
    expect(blobs('blob:limit=203')).toBe(2);
    expect(blobs('blob:limit=2')).toBeUndefined();
  });

  it('applies blob:none, blob:limit and tree:<depth> filters', async () => {
    const { repo, commits } = await chain();
    const want = [commits[3]?.sha ?? ''];
    expect(kinds(selectPack(repo, { wants: want, haves: [], filter: 'blob:none' }).objects)).toEqual({
      commit: 4,
      tree: 8,
    });
    expect(
      kinds(selectPack(repo, { wants: want, haves: [], filter: 'blob:limit=250' }).objects)['blob'],
    ).toBe(2);
    expect(kinds(selectPack(repo, { wants: want, haves: [], filter: 'blob:limit=1k' }).objects)['blob']).toBe(
      4,
    );
    expect(kinds(selectPack(repo, { wants: want, haves: [], filter: 'tree:0' }).objects)).toEqual({
      commit: 4,
    });
    expect(kinds(selectPack(repo, { wants: want, haves: [], filter: 'tree:1' }).objects)).toEqual({
      commit: 4,
      tree: 4,
    });
  });

  it('always sends explicitly wanted trees and blobs, filtered below them', async () => {
    const { repo, commits } = await chain();
    const root = commits[0]?.commit.tree ?? '';
    const blob = commits[0]?.objects.find((object) => object.type === 'blob')?.sha ?? '';
    expect(kinds(selectPack(repo, { wants: [root], haves: [], filter: 'tree:1' }).objects)).toEqual({
      tree: 1,
    });
    expect(kinds(selectPack(repo, { wants: [blob], haves: [], filter: 'blob:none' }).objects)).toEqual({
      blob: 1,
    });
  });

  it('leaves out objects reachable from the haves', async () => {
    const { repo, commits } = await chain();
    const selected = selectPack(repo, {
      wants: [commits[3]?.sha ?? ''],
      haves: [commits[2]?.sha ?? '', 'f'.repeat(40)],
    });
    expect(kinds(selected.objects)).toEqual({ commit: 1, tree: 2, blob: 1 });
  });
});
