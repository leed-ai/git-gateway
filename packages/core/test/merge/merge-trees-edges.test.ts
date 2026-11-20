// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { mergeTrees } from '../../src/merge/merge-trees.ts';
import type { TreeMergeResult } from '../../src/schemas/tree-merge.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { arbitrarySnapshot } from '../helpers/arbitraries.ts';
import { MemoryStore, textFile, type Snapshot } from '../helpers/memory-store.ts';
import { flattenSignature, toSnapshot } from '../helpers/reference-model.ts';

const BASE: Snapshot = new Map([
  ['README.md', textFile('# Site\n')],
  ['content/about.md', textFile('About\n')],
  ['content/blog/one.md', textFile('One\n')],
  ['link', textFile('README.md', '120000')],
]);

function edit(changes: Record<string, string | null | [string, '100755' | '120000']>): Snapshot {
  const next = new Map(BASE);
  for (const [path, change] of Object.entries(changes)) {
    if (change === null) next.delete(path);
    else if (typeof change === 'string') next.set(path, textFile(change));
    else next.set(path, textFile(change[0], change[1]));
  }
  return next;
}

async function merge(
  ours: Snapshot,
  theirs: Snapshot,
  base: Snapshot = BASE,
): Promise<{ result: TreeMergeResult; files?: Map<string, string> }> {
  const store = new MemoryStore();
  const result = await mergeTrees(
    {
      base: await store.writeSnapshot(base),
      ours: await store.writeSnapshot(ours),
      theirs: await store.writeSnapshot(theirs),
    },
    store,
  );
  if (result.status === 'conflict') return { result };
  store.put(result.objects);
  return { result, files: await flattenSignature(store, result.tree) };
}

async function signature(snapshot: Snapshot): Promise<Map<string, string>> {
  const store = new MemoryStore();
  return flattenSignature(store, await store.writeSnapshot(snapshot));
}

describe('mergeTrees edge cases', () => {
  it('merges the same file deleted on both sides', async () => {
    const { files } = await merge(
      edit({ 'README.md': null, 'content/about.md': 'o' }),
      edit({ 'README.md': null, 'content/blog/one.md': 't' }),
    );
    expect(files).toEqual(
      await signature(edit({ 'README.md': null, 'content/about.md': 'o', 'content/blog/one.md': 't' })),
    );
  });

  it('takes a file replaced by a directory on one side', async () => {
    const ours = edit({ 'README.md': null, 'README.md/index.md': 'i' });
    const theirs = edit({ 'content/about.md': 't' });
    const { files } = await merge(ours, theirs);
    expect(files).toEqual(
      await signature(edit({ 'README.md': null, 'README.md/index.md': 'i', 'content/about.md': 't' })),
    );
  });

  it('merges a directory both sides created with different files', async () => {
    const { files } = await merge(edit({ 'new/a.md': 'a' }), edit({ 'new/b.md': 'b' }));
    expect(files).toEqual(await signature(edit({ 'new/a.md': 'a', 'new/b.md': 'b' })));
  });

  it('conflicts on a file one side added where the other added a directory', async () => {
    const { result } = await merge(edit({ x: 'file' }), edit({ 'x/y/z.md': 'deep' }));
    expect(result).toEqual({ status: 'conflict', paths: ['x', 'x/y/z.md'] });
  });

  it('conflicts only on the changed file when the other side removes its directory', async () => {
    const { result } = await merge(
      edit({ 'content/blog/one.md': 'changed' }),
      edit({ 'content/blog/one.md': null, 'content/about.md': null }),
    );
    expect(result).toEqual({ status: 'conflict', paths: ['content/blog/one.md'] });
  });

  it('keeps a new file added inside a directory the other side emptied of its old files', async () => {
    const { files } = await merge(
      edit({ 'content/new.md': 'n' }),
      edit({ 'content/about.md': null, 'content/blog/one.md': null }),
    );
    expect(files).toEqual(
      await signature(edit({ 'content/new.md': 'n', 'content/about.md': null, 'content/blog/one.md': null })),
    );
  });

  it('conflicts when one side retargets a symbolic link and the other turns it into a file', async () => {
    const { result } = await merge(edit({ link: ['content/about.md', '120000'] }), edit({ link: 'text' }));
    expect(result).toEqual({ status: 'conflict', paths: ['link'] });
  });

  it('conflicts when one side makes a file executable and the other deletes it', async () => {
    const { result } = await merge(
      edit({ 'README.md': ['# Site\n', '100755'] }),
      edit({ 'README.md': null }),
    );
    expect(result).toEqual({ status: 'conflict', paths: ['README.md'] });
  });

  it('merges from an empty base when both sides add different files', async () => {
    const { files } = await merge(
      new Map([['a.md', textFile('a')]]),
      new Map([['b.md', textFile('b')]]),
      new Map(),
    );
    expect(files).toEqual(
      await signature(
        new Map([
          ['a.md', textFile('a')],
          ['b.md', textFile('b')],
        ]),
      ),
    );
  });
});

describe('mergeTrees when every path is deleted', () => {
  const BOTH: Snapshot = new Map([
    ['a', textFile('a')],
    ['c', textFile('c')],
  ]);

  it('returns no objects when one side already is the empty tree', async () => {
    const { result, files } = await merge(new Map(), new Map([['c', textFile('c')]]), BOTH);
    expect(result).toEqual({ status: 'merged', tree: EMPTY_TREE_SHA, objects: [] });
    expect(files).toEqual(new Map());
  });

  it('returns the empty tree as a new object when no input is the empty tree', async () => {
    const { result, files } = await merge(
      new Map([['c', textFile('c')]]),
      new Map([['a', textFile('a')]]),
      BOTH,
    );
    expect(files).toEqual(new Map());
    expect(result).toMatchObject({ status: 'merged', tree: EMPTY_TREE_SHA });
    expect(result.status === 'merged' && result.objects.map((object) => object.sha)).toEqual([
      EMPTY_TREE_SHA,
    ]);
  });
});

describe('mergeTrees properties', () => {
  it('is idempotent: merging a side with itself or with the base gives that side', async () => {
    await fc.assert(
      fc.asyncProperty(arbitrarySnapshot, arbitrarySnapshot, async (base, side) => {
        const store = new MemoryStore();
        const baseTree = await store.writeSnapshot(toSnapshot(base));
        const sideTree = await store.writeSnapshot(toSnapshot(side));
        expect(await mergeTrees({ base: baseTree, ours: sideTree, theirs: sideTree }, store)).toEqual({
          status: 'merged',
          tree: sideTree,
          objects: [],
        });
        expect(await mergeTrees({ base: baseTree, ours: baseTree, theirs: sideTree }, store)).toMatchObject({
          tree: sideTree,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('returns new tree objects that, with the inputs, fully describe the merged tree', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySnapshot,
        arbitrarySnapshot,
        arbitrarySnapshot,
        async (base, ours, theirs) => {
          const store = new MemoryStore();
          const input = {
            base: await store.writeSnapshot(toSnapshot(base)),
            ours: await store.writeSnapshot(toSnapshot(ours)),
            theirs: await store.writeSnapshot(toSnapshot(theirs)),
          };
          const result = await mergeTrees(input, store);
          const paths = result.status === 'conflict' ? result.paths : ['ok'];
          expect(paths.length).toBeGreaterThan(0);
          expect(new Set(paths).size).toBe(paths.length);
          if (result.status === 'conflict') return;
          for (const object of result.objects) expect(object.type).toBe('tree');
          expect([input.base, input.ours, input.theirs]).not.toContain(
            result.objects.find((object) => object.sha === result.tree)?.sha,
          );
          store.put(result.objects);
          await expect(store.flatten(result.tree)).resolves.toBeInstanceOf(Map);
        },
      ),
      { numRuns: 300 },
    );
  });
});
