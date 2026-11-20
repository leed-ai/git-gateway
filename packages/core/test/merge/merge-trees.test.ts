// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { mergeTrees } from '../../src/merge/merge-trees.ts';
import type { TreeMergeResult } from '../../src/schemas/tree-merge.ts';
import { editTree } from '../../src/tree/edit-tree.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { MemoryStore, textFile, type Snapshot } from '../helpers/memory-store.ts';
import { flattenSignature } from '../helpers/reference-model.ts';

const BASE: Snapshot = new Map([
  ['README.md', textFile('# Site\n')],
  ['content/about.md', textFile('About\n')],
  ['content/blog/one.md', textFile('One\n')],
  ['templates/page.hbs', textFile('{{body}}\n')],
]);

/** Changes to the base snapshot: new text, null to delete, or [text, mode]. */
type Changes = Record<string, string | null | [string, '100755']>;

function variant(changes: Changes): Snapshot {
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
): Promise<{ result: TreeMergeResult; store: MemoryStore; files?: Map<string, string> }> {
  const store = new MemoryStore();
  const base = await store.writeSnapshot(BASE);
  const oursTree = await store.writeSnapshot(ours);
  const theirsTree = await store.writeSnapshot(theirs);
  store.treeReads.length = 0;
  const result = await mergeTrees({ base, ours: oursTree, theirs: theirsTree }, store);
  if (result.status === 'conflict') return { result, store };
  store.put(result.objects);
  return { result, store, files: await flattenSignature(store, result.tree) };
}

async function expected(snapshot: Snapshot): Promise<Map<string, string>> {
  const store = new MemoryStore();
  return flattenSignature(store, await store.writeSnapshot(snapshot));
}

describe('mergeTrees', () => {
  it("takes each side's changes to different paths", async () => {
    const ours = variant({ 'content/about.md': 'About us\n', 'new/ours.md': 'o' });
    const theirs = variant({ 'templates/page.hbs': '<main>{{body}}</main>\n', 'content/blog/one.md': null });
    const { files } = await merge(ours, theirs);
    expect(files).toEqual(
      await expected(
        variant({
          'content/about.md': 'About us\n',
          'new/ours.md': 'o',
          'templates/page.hbs': '<main>{{body}}</main>\n',
          'content/blog/one.md': null,
        }),
      ),
    );
  });

  it('accepts the same change made on both sides', async () => {
    const both = variant({ 'README.md': 'same\n' });
    const { files } = await merge(both, variant({ 'README.md': 'same\n', 'content/about.md': 'x' }));
    expect(files).toEqual(await expected(variant({ 'README.md': 'same\n', 'content/about.md': 'x' })));
  });

  it('takes a one-sided mode change', async () => {
    const { files } = await merge(
      variant({ 'README.md': ['# Site\n', '100755'] }),
      variant({ 'content/about.md': 'x' }),
    );
    expect(files?.get('README.md')).toMatch(/^100755 /);
  });

  it.each<[string, Changes, Changes, string[]]>([
    ['content changed differently', { 'README.md': 'ours\n' }, { 'README.md': 'theirs\n' }, ['README.md']],
    [
      'modified against deleted',
      { 'content/about.md': 'changed\n' },
      { 'content/about.md': null },
      ['content/about.md'],
    ],
    ['added differently on both', { 'new.md': 'a' }, { 'new.md': 'b' }, ['new.md']],
    [
      'mode changed against content changed',
      { 'README.md': ['# Site\n', '100755'] },
      { 'README.md': 'other\n' },
      ['README.md'],
    ],
  ])('reports a conflict when %s', async (_, ours, theirs, paths) => {
    const { result } = await merge(variant(ours), variant(theirs));
    expect(result).toEqual({ status: 'conflict', paths });
  });

  it('reports a file against a directory with every merged path beneath it', async () => {
    const ours = variant({ 'README.md': null, 'README.md/a': 'a', 'README.md/b/c': 'c' });
    const theirs = variant({ 'README.md': 'changed\n' });
    const { result } = await merge(ours, theirs);
    expect(result).toEqual({ status: 'conflict', paths: ['README.md', 'README.md/a', 'README.md/b/c'] });
  });

  it('sorts conflicting paths in byte order', async () => {
    const { result } = await merge(
      variant({ 'b.md': '1', 'a.md': '1', 'é.md': '1' }),
      variant({ 'b.md': '2', 'a.md': '2', 'é.md': '2' }),
    );
    expect(result).toEqual({ status: 'conflict', paths: ['a.md', 'b.md', 'é.md'] });
  });

  it('reads no tree when one side is unchanged', async () => {
    const { result, store } = await merge(BASE, variant({ 'README.md': 'x' }));
    expect(result.status).toBe('merged');
    expect(store.treeReads).toEqual([]);
  });

  it('reads only the directories whose ids differ on both sides', async () => {
    const store = new MemoryStore();
    const base = await store.writeSnapshot(BASE);
    const ours = await store.writeSnapshot(variant({ 'README.md': 'o' }));
    const theirs = await store.writeSnapshot(variant({ 'content/about.md': 't' }));
    store.treeReads.length = 0;
    await mergeTrees({ base, ours, theirs }, store);
    // Only the roots: content/ changed on one side only and templates/ on neither, so neither is read.
    expect(store.treeReads.toSorted()).toEqual([base, ours, theirs].toSorted());
  });

  it('descends into a directory both sides changed', async () => {
    const store = new MemoryStore();
    const base = await store.writeSnapshot(BASE);
    const ours = await store.writeSnapshot(variant({ 'content/about.md': 'o' }));
    const theirs = await store.writeSnapshot(variant({ 'content/blog/one.md': 't' }));
    store.treeReads.length = 0;
    const result = await mergeTrees({ base, ours, theirs }, store);
    expect(store.treeReads).toHaveLength(6);
    store.put(result.status === 'merged' ? result.objects : []);
    expect(result.status === 'merged' && (await flattenSignature(store, result.tree))).toEqual(
      await expected(variant({ 'content/about.md': 'o', 'content/blog/one.md': 't' })),
    );
  });

  it('returns only tree objects none of the inputs had', async () => {
    const { result } = await merge(variant({ 'README.md': 'o' }), variant({ 'content/about.md': 't' }));
    expect(result.status === 'merged' && result.objects.map((object) => object.type)).toEqual(['tree']);
  });

  it('merges to the empty tree when both sides delete everything differently', async () => {
    const store = new MemoryStore();
    const base = await store.writeSnapshot(
      new Map([
        ['a', textFile('a')],
        ['b', textFile('b')],
      ]),
    );
    const ours = await store.writeSnapshot(new Map([['b', textFile('b')]]));
    const theirs = await store.writeSnapshot(new Map([['a', textFile('a')]]));
    const result = await mergeTrees({ base, ours, theirs }, store);
    expect(result).toMatchObject({ status: 'merged', tree: EMPTY_TREE_SHA });
  });

  it('keeps a submodule pointer changed on one side', async () => {
    const store = new MemoryStore();
    const base = await store.writeSnapshot(BASE);
    const withModule = async (sha: string): Promise<string> => {
      const edited = await editTree(
        { tree: base, changes: [{ op: 'set', path: 'vendor/lib', mode: '160000', sha }] },
        store,
      );
      store.put(edited.objects);
      return edited.tree;
    };
    const left = await withModule('1'.repeat(40));
    const right = await withModule('2'.repeat(40));
    const result = await mergeTrees({ base: left, ours: left, theirs: right }, store);
    expect(result).toEqual({ status: 'merged', tree: right, objects: [] });
    const both = await mergeTrees({ base, ours: left, theirs: right }, store);
    expect(both).toEqual({ status: 'conflict', paths: ['vendor/lib'] });
  });

  it('reports a tree it cannot read', async () => {
    const error = await mergeTrees(
      { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) },
      new MemoryStore(),
    ).catch((thrown: unknown) => thrown);
    expect(isCoreError(error, 'missing_object')).toBe(true);
  });

  it('refuses invalid input', async () => {
    await expect(mergeTrees({ base: 'x', ours: 'y', theirs: 'z' }, new MemoryStore())).rejects.toThrow(
      ZodError,
    );
  });
});
