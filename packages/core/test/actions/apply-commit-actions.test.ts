// SPDX-License-Identifier: Apache-2.0
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { applyCommitActions } from '../../src/actions/apply-commit-actions.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { EMPTY_TREE_SHA } from '../../src/tree/tree-reader.ts';
import { apply, errorOf, setup, sha } from '../helpers/action-fixture.ts';
import { MemoryStore } from '../helpers/memory-store.ts';

describe('applyCommitActions', () => {
  it('decodes base64 content to raw bytes', async () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff);
    const files = await apply([
      { action: 'create', path: 'logo.png', content: btoa(String.fromCodePoint(...png)), encoding: 'base64' },
    ]);
    expect(files.get('logo.png')?.sha).toBe(await hashObject('blob', png));
  });

  it('applies actions in order, each to the result of the one before', async () => {
    const files = await apply([
      { action: 'create', path: 'tmp.md', content: 'a' },
      { action: 'update', path: 'tmp.md', content: 'b' },
      { action: 'move', previousPath: 'tmp.md', path: 'final.md' },
      { action: 'chmod', path: 'final.md', executeFilemode: true },
    ]);
    expect(files.get('final.md')).toMatchObject({ mode: '100755', sha: await sha('b') });
    expect(files.has('tmp.md')).toBe(false);
  });

  it('fails as a whole on the first broken rule', async () => {
    expect(
      await errorOf([
        { action: 'create', path: 'ok.md', content: 'a' },
        { action: 'delete', path: 'missing.md' },
      ]),
    ).toMatchObject({
      code: 'path_not_found',
    });
  });

  it.each<[string, CommitActionInput[]]>([
    ['an update with the same content', [{ action: 'update', path: 'README.md', content: '# Site\n' }]],
    ['a chmod to the current mode', [{ action: 'chmod', path: 'scripts/build.sh', executeFilemode: true }]],
    [
      'a create then delete',
      [
        { action: 'create', path: 'x.md', content: 'x' },
        { action: 'delete', path: 'x.md' },
      ],
    ],
    [
      'a move there and back',
      [
        { action: 'move', previousPath: 'README.md', path: 'R.md' },
        { action: 'move', previousPath: 'R.md', path: 'README.md' },
      ],
    ],
  ])('reports %s as a no-op', async (_, actions) => {
    const { store, root } = await setup();
    expect(await applyCommitActions({ tree: root, actions }, store)).toEqual({ status: 'noop', tree: root });
  });

  it('reports a no-op on an empty repository with the empty tree', async () => {
    const result = await applyCommitActions(
      {
        tree: null,
        actions: [
          { action: 'create', path: 'a', content: '' },
          { action: 'delete', path: 'a' },
        ],
      },
      new MemoryStore(),
    );
    expect(result).toEqual({ status: 'noop', tree: EMPTY_TREE_SHA });
  });

  it('returns only the blobs the final tree uses, then the new trees', async () => {
    const { store, root } = await setup();
    const result = await applyCommitActions(
      {
        tree: root,
        actions: [
          { action: 'create', path: 'content/a.md', content: 'draft' },
          { action: 'update', path: 'content/a.md', content: 'final' },
        ],
      },
      store,
    );
    if (result.status !== 'changed') throw new Error('expected a change');
    expect(result.objects.map((object) => object.type)).toEqual(['blob', 'tree', 'tree']);
    expect(result.objects[0]?.sha).toBe(await sha('final'));
  });

  it('builds a first tree on an empty repository', async () => {
    const store = new MemoryStore();
    const result = await applyCommitActions(
      { tree: null, actions: [{ action: 'create', path: 'a.md', content: 'a' }] },
      store,
    );
    expect(result.status).toBe('changed');
  });

  it('refuses invalid actions before reading anything', async () => {
    const store = new MemoryStore();
    await expect(applyCommitActions({ tree: null, actions: [] }, store)).rejects.toThrow(ZodError);
    await expect(
      applyCommitActions(
        { tree: null, actions: [{ action: 'create', path: 'a', content: '!!', encoding: 'base64' }] },
        store,
      ),
    ).rejects.toThrow(ZodError);
    expect(store.treeReads).toEqual([]);
  });
});
