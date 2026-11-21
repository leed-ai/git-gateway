// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { TreeOverlay } from '../../src/tree/tree-overlay.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { MemoryStore, textFile } from '../helpers/memory-store.ts';

const BLOB = 'ce013625030ba8dba906f756967f9e9ca394464a';

async function setup(): Promise<{ store: MemoryStore; overlay: TreeOverlay; root: string }> {
  const store = new MemoryStore();
  const root = await store.writeSnapshot(
    new Map([
      ['a.md', textFile('a')],
      ['dir/b.md', textFile('b')],
      ['dir/sub/c.md', textFile('c')],
    ]),
  );
  store.treeReads.length = 0;
  return { store, overlay: new TreeOverlay(store, root), root };
}

describe('TreeOverlay', () => {
  it('reports what each kind of path names', async () => {
    const { overlay } = await setup();
    expect(await overlay.stat('a.md')).toMatchObject({ kind: 'file' });
    expect(await overlay.stat('dir')).toEqual({ kind: 'directory' });
    expect(await overlay.stat('dir/sub/missing')).toEqual({ kind: 'missing' });
    expect(await overlay.stat('a.md/x/y')).toEqual({ kind: 'blocked', at: 'a.md' });
    expect(await overlay.stat('nope/x')).toEqual({ kind: 'missing' });
  });

  it('refuses to set a path whose parent is a file', async () => {
    const { overlay } = await setup();
    await expect(overlay.set('a.md/x', '100644', BLOB)).rejects.toThrow(/not a directory/);
  });

  it('ignores the removal of a path that is absent or beneath a file', async () => {
    const { overlay, root } = await setup();
    await overlay.remove('missing.md');
    await overlay.remove('a.md/x');
    await overlay.remove('nope/deeper/x');
    expect(await overlay.write()).toMatchObject({ tree: root, objects: [] });
  });

  it('prunes every directory a removal leaves empty, up to the root', async () => {
    const store = new MemoryStore();
    const root = await store.writeSnapshot(new Map([['x/y/z.md', textFile('z')]]));
    const overlay = new TreeOverlay(store, root);
    await overlay.remove('x/y/z.md');
    expect((await overlay.write()).tree).toBe(EMPTY_TREE_SHA);
  });

  it('keeps a parent directory that still has other entries', async () => {
    const { overlay, store } = await setup();
    await overlay.remove('dir/sub/c.md');
    const written = await overlay.write();
    store.put(written.objects);
    expect([...(await store.flatten(written.tree)).keys()].toSorted()).toEqual(['a.md', 'dir/b.md']);
  });

  it('starts empty from the empty tree id without reading it', async () => {
    const store = new MemoryStore();
    const overlay = new TreeOverlay(store, EMPTY_TREE_SHA);
    expect(await overlay.stat('anything')).toEqual({ kind: 'missing' });
    expect(store.treeReads).toEqual([]);
    expect((await overlay.write()).tree).toBe(EMPTY_TREE_SHA);
  });

  it('reads a directory once however often it is visited', async () => {
    const { overlay, store } = await setup();
    await overlay.stat('dir/sub/c.md');
    await overlay.stat('dir/sub/c.md');
    await overlay.set('dir/sub/d.md', '100644', BLOB);
    await overlay.remove('dir/sub/c.md');
    expect(new Set(store.treeReads).size).toBe(store.treeReads.length);
  });
});
