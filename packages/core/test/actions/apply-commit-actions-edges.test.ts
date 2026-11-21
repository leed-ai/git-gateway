// SPDX-License-Identifier: Apache-2.0
import { isGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { applyCommitActions } from '../../src/actions/apply-commit-actions.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { decodeTree } from '../../src/objects/tree-object.ts';
import { arbitraryContent, arbitraryPath, arbitrarySnapshot } from '../helpers/arbitraries.ts';
import { apply, errorOf, setup, sha } from '../helpers/action-fixture.ts';
import { MemoryStore } from '../helpers/memory-store.ts';
import { toSnapshot } from '../helpers/reference-model.ts';

describe('action rules on a path beneath a file', () => {
  it.each<[string, CommitActionInput]>([
    ['delete', { action: 'delete', path: 'README.md/x' }],
    ['chmod', { action: 'chmod', path: 'README.md/x', executeFilemode: true }],
    ['move (source)', { action: 'move', previousPath: 'README.md/x', path: 'y.md' }],
  ])('%s fails with path_not_found', async (_, action) => {
    const path = action.action === 'move' ? action.previousPath : action.path;
    expect(await errorOf([action])).toEqual({ code: 'path_not_found', details: { path } });
  });
});

describe('modes carried by actions', () => {
  it('upsert keeps a symbolic link a symbolic link', async () => {
    const files = await apply([{ action: 'upsert', path: 'current', content: 'README.md' }]);
    expect(files.get('current')).toMatchObject({ mode: '120000', sha: await sha('README.md') });
  });

  it('move keeps a symbolic link a symbolic link', async () => {
    const files = await apply([{ action: 'move', previousPath: 'current', path: 'links/current' }]);
    expect(files.has('current')).toBe(false);
    expect(files.get('links/current')).toMatchObject({
      mode: '120000',
      sha: await sha('content/about.md'),
    });
  });

  it('a later update keeps the mode an earlier chmod set', async () => {
    const files = await apply([
      { action: 'chmod', path: 'README.md', executeFilemode: true },
      { action: 'update', path: 'README.md', content: 'new' },
    ]);
    expect(files.get('README.md')).toMatchObject({ mode: '100755', sha: await sha('new') });
  });

  it('a submodule cannot be moved', async () => {
    expect(await errorOf([{ action: 'move', previousPath: 'vendor/lib', path: 'lib' }])).toEqual({
      code: 'path_not_found',
      details: { path: 'vendor/lib' },
    });
  });
});

describe('move edge cases', () => {
  it('writes base64 content when moving', async () => {
    const binary = Uint8Array.of(0x00, 0xff, 0x10, 0x80);
    const files = await apply([
      {
        action: 'move',
        previousPath: 'README.md',
        path: 'img/blob.bin',
        content: btoa(String.fromCodePoint(...binary)),
        encoding: 'base64',
      },
    ]);
    expect(files.get('img/blob.bin')?.sha).toBe(await hashObject('blob', binary));
  });

  it('checks the source before the destination', async () => {
    expect(await errorOf([{ action: 'move', previousPath: 'missing.md', path: 'README.md' }])).toEqual({
      code: 'path_not_found',
      details: { path: 'missing.md' },
    });
  });

  it('leaves no partial result when a later move fails', async () => {
    const { store, root } = await setup();
    const before = new Map(store.objects);
    const error = await applyCommitActions(
      {
        tree: root,
        actions: [
          { action: 'move', previousPath: 'README.md', path: 'R.md' },
          { action: 'move', previousPath: 'README.md', path: 'S.md' },
        ],
      },
      store,
    ).catch((thrown: unknown) => thrown);
    expect(isGatewayError(error)).toBe(true);
    expect(store.objects).toEqual(before);
  });
});

describe('directories emptied and refilled in one commit', () => {
  it('creates a file where a directory was emptied by an earlier delete', async () => {
    const files = await apply([
      { action: 'delete', path: 'content/blog/one.md' },
      { action: 'create', path: 'content/blog', content: 'now a file' },
    ]);
    expect(files.get('content/blog')).toMatchObject({ mode: '100644', sha: await sha('now a file') });
    expect(files.has('content/about.md')).toBe(true);
  });

  it('creates a directory where a file was deleted earlier', async () => {
    const files = await apply([
      { action: 'delete', path: 'README.md' },
      { action: 'create', path: 'README.md/index.md', content: 'i' },
    ]);
    expect(files.get('README.md/index.md')).toMatchObject({ sha: await sha('i') });
  });

  it('refuses a create in a directory that still has other files after a delete', async () => {
    expect(
      await errorOf([
        { action: 'delete', path: 'content/about.md' },
        { action: 'create', path: 'content', content: 'x' },
      ]),
    ).toEqual({ code: 'path_exists', details: { path: 'content' } });
  });
});

/** Every tree id on the way to `path` in `root`, the root included. */
async function treesAlong(store: MemoryStore, root: string, path: string): Promise<string[]> {
  const found = [root];
  let current = root;
  for (const segment of path.split('/')) {
    const object = store.objects.get(current);
    if (object?.type !== 'tree') break;
    const entry = decodeTree(object.data, current).find((e) => e.name === segment);
    if (entry?.mode !== '040000') break;
    found.push(entry.sha);
    current = entry.sha;
  }
  return found;
}

describe('applyCommitActions properties', () => {
  const action: fc.Arbitrary<CommitActionInput> = fc.oneof(
    fc.record({ action: fc.constant('create' as const), path: arbitraryPath, content: arbitraryContent }),
    fc.record({ action: fc.constant('update' as const), path: arbitraryPath, content: arbitraryContent }),
    fc.record({ action: fc.constant('upsert' as const), path: arbitraryPath, content: arbitraryContent }),
    fc.record({ action: fc.constant('delete' as const), path: arbitraryPath }),
    fc
      .record({ action: fc.constant('move' as const), previousPath: arbitraryPath, path: arbitraryPath })
      .filter((move) => move.previousPath !== move.path),
    fc.record({ action: fc.constant('chmod' as const), path: arbitraryPath, executeFilemode: fc.boolean() }),
  );

  it('reads only the trees along the paths the actions name', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySnapshot,
        fc.array(action, { minLength: 1, maxLength: 6 }),
        async (snapshot, actions) => {
          const store = new MemoryStore();
          const root = await store.writeSnapshot(toSnapshot(snapshot));
          store.treeReads.length = 0;
          await applyCommitActions({ tree: root, actions }, store).catch((thrown: unknown) => {
            if (!isGatewayError(thrown)) throw thrown;
          });
          const allowed = new Set<string>();
          for (const a of actions) {
            const paths = a.action === 'move' ? [a.previousPath, a.path] : [a.path];
            for (const path of paths)
              for (const tree of await treesAlong(store, root, path)) allowed.add(tree);
          }
          for (const read of store.treeReads) expect(allowed.has(read)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('returns every object the new tree needs that the store lacks', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySnapshot,
        fc.array(action, { minLength: 1, maxLength: 6 }),
        async (snapshot, actions) => {
          const store = new MemoryStore();
          const root = await store.writeSnapshot(toSnapshot(snapshot));
          const result = await applyCommitActions({ tree: root, actions }, store).catch(() => null);
          if (result === null || result.status === 'noop') return;
          // Only the returned objects are added; flatten throws on any tree it cannot find.
          const extended = new MemoryStore();
          extended.put([...store.objects.values()].filter((o) => o.type !== 'blob'));
          extended.put(result.objects);
          const files = await extended.flatten(result.tree);
          for (const entry of files.values()) {
            const known = store.objects.has(entry.sha) || result.objects.some((o) => o.sha === entry.sha);
            expect(known).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
