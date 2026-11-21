// SPDX-License-Identifier: Apache-2.0
import { isGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { GatewayErrorCode } from '@leed-ai/git-gateway-contract/schemas/gateway-error-body';
import type { TreeEntry } from '@leed-ai/git-gateway-contract/schemas/tree-entry';
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, hexToBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import { EntryMode, type TreeChange } from '../../src/schemas/tree-edit.ts';
import { editTree } from '../../src/tree/edit-tree.ts';
import { EMPTY_TREE_SHA, loadTree } from '../../src/tree/tree-reader.ts';
import { arbitraryPath, arbitrarySha } from '../helpers/arbitraries.ts';
import { MemoryStore, textFile, type Snapshot } from '../helpers/memory-store.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const BLOB = 'ce013625030ba8dba906f756967f9e9ca394464a';

const SNAPSHOT: Snapshot = new Map([
  ['README.md', textFile('# Site\n')],
  ['content/about.md', textFile('About\n')],
  ['content/blog/one.md', textFile('One\n')],
  ['templates/page.hbs', textFile('{{body}}\n')],
  ['scripts/build.sh', textFile('#!/bin/sh\n', '100755')],
]);

async function setup(): Promise<{ store: MemoryStore; root: string }> {
  const store = new MemoryStore();
  const root = await store.writeSnapshot(SNAPSHOT);
  store.treeReads.length = 0;
  return { store, root };
}

async function edit(store: MemoryStore, tree: string | null, changes: TreeChange[]): Promise<string> {
  const result = await editTree({ tree, changes }, store);
  store.put(result.objects);
  return result.tree;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('editTree', () => {
  it('sets a file, creating missing directories', async () => {
    const { store, root } = await setup();
    const tree = await edit(store, root, [
      { op: 'set', path: 'content/new/deep/x.md', mode: '100644', sha: BLOB },
    ]);
    expect((await store.flatten(tree)).get('content/new/deep/x.md')).toEqual({
      name: 'x.md',
      mode: '100644',
      sha: BLOB,
    });
  });

  it('replaces a file entry, mode included', async () => {
    const { store, root } = await setup();
    const tree = await edit(store, root, [{ op: 'set', path: 'README.md', mode: '100755', sha: BLOB }]);
    expect((await store.flatten(tree)).get('README.md')).toEqual({
      name: 'README.md',
      mode: '100755',
      sha: BLOB,
    });
  });

  it('removes a file and the directories it leaves empty', async () => {
    const { store, root } = await setup();
    const tree = await edit(store, root, [{ op: 'remove', path: 'content/blog/one.md' }]);
    const flat = await store.flatten(tree);
    expect([...flat.keys()].toSorted()).toEqual([
      'README.md',
      'content/about.md',
      'scripts/build.sh',
      'templates/page.hbs',
    ]);
    const content = (await loadTree(store, tree)).find((entry) => entry.name === 'content');
    expect((await loadTree(store, content?.sha ?? '')).map((entry) => entry.name)).toEqual(['about.md']);
  });

  it('removing the last file leaves the empty tree', async () => {
    const store = new MemoryStore();
    const root = await store.writeSnapshot(new Map([['a/b/c', textFile('x')]]));
    const result = await editTree({ tree: root, changes: [{ op: 'remove', path: 'a/b/c' }] }, store);
    expect(result.tree).toBe(EMPTY_TREE_SHA);
  });

  it('starts from an empty tree when given null', async () => {
    const store = new MemoryStore();
    expect((await editTree({ tree: null, changes: [] }, store)).tree).toBe(EMPTY_TREE_SHA);
    const tree = await edit(store, null, [{ op: 'set', path: 'a.txt', mode: '100644', sha: BLOB }]);
    expect(tree).toBe(
      (await createObject('tree', concatBytes([bytes('100644 a.txt\0'), hexToBytes(BLOB)]))).sha,
    );
  });

  it('returns the input tree and no objects when nothing changes', async () => {
    const { store, root } = await setup();
    const blob = (await store.flatten(root)).get('README.md')?.sha ?? '';
    const result = await editTree(
      { tree: root, changes: [{ op: 'set', path: 'README.md', mode: '100644', sha: blob }] },
      store,
    );
    expect(result).toEqual({ tree: root, objects: [] });
  });

  it('reads only the trees along the edited paths and rewrites only those', async () => {
    const { store, root } = await setup();
    const result = await editTree(
      { tree: root, changes: [{ op: 'set', path: 'content/blog/two.md', mode: '100644', sha: BLOB }] },
      store,
    );
    const reads = [...store.treeReads];
    const rootEntries = await loadTree(store, root);
    const content = rootEntries.find((entry) => entry.name === 'content')?.sha ?? '';
    const blog = (await loadTree(store, content)).find((entry) => entry.name === 'blog')?.sha ?? '';
    expect(reads).toEqual([root, content, blog]);
    expect(result.objects).toHaveLength(3);
    const untouched = rootEntries.filter((entry) => entry.name !== 'content');
    store.put(result.objects);
    const after = await loadTree(store, result.tree);
    for (const entry of untouched) expect(after).toContainEqual(entry);
  });

  it('applies changes in order', async () => {
    const { store, root } = await setup();
    const tree = await edit(store, root, [
      { op: 'set', path: 'x/y', mode: '100644', sha: BLOB },
      { op: 'remove', path: 'x/y' },
      { op: 'set', path: 'x', mode: '120000', sha: BLOB },
    ]);
    expect((await store.flatten(tree)).get('x')).toEqual({ name: 'x', mode: '120000', sha: BLOB });
  });

  it.each<[string, TreeChange, GatewayErrorCode]>([
    ['setting a directory', { op: 'set', path: 'content', mode: '100644', sha: BLOB }, 'path_exists'],
    [
      'setting beneath a file',
      { op: 'set', path: 'README.md/x', mode: '100644', sha: BLOB },
      'path_conflict',
    ],
    ['removing a missing path', { op: 'remove', path: 'nope.md' }, 'path_not_found'],
    ['removing a directory', { op: 'remove', path: 'content' }, 'path_not_found'],
    ['removing beneath a file', { op: 'remove', path: 'README.md/x' }, 'path_not_found'],
  ])('refuses %s', async (_, change, code) => {
    const { store, root } = await setup();
    expect(
      isGatewayError(await failure(() => editTree({ tree: root, changes: [change] }, store)), code),
    ).toBe(true);
  });

  it('removes a submodule entry', async () => {
    const store = new MemoryStore();
    const tree = await edit(store, null, [
      { op: 'set', path: 'vendor/lib', mode: '160000', sha: BLOB },
      { op: 'set', path: 'keep', mode: '100644', sha: BLOB },
    ]);
    const after = await edit(store, tree, [{ op: 'remove', path: 'vendor/lib' }]);
    expect([...(await store.flatten(after)).keys()]).toEqual(['keep']);
  });

  it('reports a tree the reader does not have', async () => {
    const store = new MemoryStore();
    const missing = '1'.repeat(40);
    const error = await failure(() =>
      editTree({ tree: missing, changes: [{ op: 'remove', path: 'a' }] }, store),
    );
    expect(isCoreError(error, 'missing_object')).toBe(true);
  });

  it('reports a reader that returns invalid entries', async () => {
    const entries: GitTreeEntry[] = [{ name: 'a/b', mode: '100644', sha: BLOB }];
    const reader = { readTree: async () => entries };
    const error = await failure(() =>
      editTree({ tree: '1'.repeat(40), changes: [{ op: 'remove', path: 'a' }] }, reader),
    );
    expect(isCoreError(error, 'invalid_object')).toBe(true);
  });

  it('accepts contract TreeEntry objects from a reader', async () => {
    const entries: TreeEntry[] = [{ path: 'a.md', name: 'a.md', type: 'blob', mode: '100644', sha: BLOB }];
    const reader = { readTree: async () => entries };
    const result = await editTree(
      { tree: '1'.repeat(40), changes: [{ op: 'remove', path: 'a.md' }] },
      reader,
    );
    expect(result.tree).toBe(EMPTY_TREE_SHA);
  });

  it('refuses invalid input', async () => {
    const store = new MemoryStore();
    await expect(editTree({ tree: null, changes: [{ op: 'remove', path: '/abs' }] }, store)).rejects.toThrow(
      ZodError,
    );
  });
});

describe('editTree properties', () => {
  const change: fc.Arbitrary<TreeChange> = fc.oneof(
    fc.record({
      op: fc.constant('set' as const),
      path: arbitraryPath,
      mode: fc.constantFrom('100644' as const, '100755' as const),
      sha: arbitrarySha,
    }),
    fc.record({ op: fc.constant('remove' as const), path: arbitraryPath }),
  );

  it('preserves untouched entries byte-for-byte and equals a tree built from scratch', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(change, { maxLength: 8 }),
        fc.array(change, { maxLength: 8 }),
        async (first, second) => {
          const store = new MemoryStore();
          const base = await editTree({ tree: null, changes: first }, store).catch(() => null);
          if (base === null) return;
          store.put(base.objects);
          const before = await store.flatten(base.tree);
          const edited = await editTree({ tree: base.tree, changes: second }, store).catch(() => null);
          if (edited === null) return;
          store.put(edited.objects);
          const after = await store.flatten(edited.tree);
          const touched = (path: string): boolean =>
            second.some(
              (c) => c.path === path || path.startsWith(`${c.path}/`) || c.path.startsWith(`${path}/`),
            );
          const untouched = [...before].filter(([path]) => !touched(path));
          expect(untouched.map(([path]) => [path, after.get(path)])).toEqual(untouched);
          const rebuilt = await editTree(
            {
              tree: null,
              changes: [...after].map(([path, e]) => ({
                op: 'set',
                path,
                mode: EntryMode.parse(e.mode),
                sha: e.sha,
              })),
            },
            new MemoryStore(),
          );
          expect(rebuilt.tree).toBe(edited.tree);
        },
      ),
      { numRuns: 150 },
    );
  });
});
