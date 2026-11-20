// SPDX-License-Identifier: Apache-2.0
import { FilePath } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { GitObject } from './git-object.ts';

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The modes a tree edit may write: anything but a directory, which edits create implicitly. */
export const EntryMode = z.enum(['100644', '100755', '120000', '160000']).meta({
  id: 'EntryMode',
  title: 'Entry mode',
  description:
    'The mode of a non-directory tree entry; directories are created and removed implicitly by paths.',
  enumDescriptions: {
    '100644': 'A regular file, not executable.',
    '100755': 'A regular file with the executable bit set.',
    '120000': 'A symbolic link; the blob holds the link target.',
    '160000': 'A submodule; the id names a commit in another repository.',
  },
  examples: ['100644', '100755'],
});

/** Point a path at an object. */
export const SetEntryChange = z
  .object({
    op: z.literal('set').describe('Create or replace the entry at `path`.'),
    path: FilePath.describe(
      'Path of the entry. Missing parent directories are created; fails with path_exists if the path is a directory and path_conflict if a parent is not a directory.',
    ),
    mode: EntryMode,
    sha: Sha.describe(
      'Id of the blob (or submodule commit) the entry names. It must exist or be pushed with the tree.',
    ),
  })
  .strict()
  .meta({
    id: 'SetEntryChange',
    title: 'Set entry',
    description:
      'Creates or replaces a non-directory entry at a path, creating parent directories as needed.',
    examples: [{ op: 'set', path: 'content/about.md', mode: '100644', sha: EMPTY_BLOB }],
  });

/** Remove the entry at a path. */
export const RemoveEntryChange = z
  .object({
    op: z.literal('remove').describe('Remove the entry at `path`.'),
    path: FilePath.describe(
      'Path of a non-directory entry. Fails with path_not_found if it is absent or a directory. Directories left empty disappear.',
    ),
  })
  .strict()
  .meta({
    id: 'RemoveEntryChange',
    title: 'Remove entry',
    description: 'Removes a non-directory entry; directories it leaves empty are removed too.',
    examples: [{ op: 'remove', path: 'content/old.md' }],
  });

/** One low-level tree edit. */
export const TreeChange = z.discriminatedUnion('op', [SetEntryChange, RemoveEntryChange]).meta({
  id: 'TreeChange',
  title: 'Tree change',
  description: 'One low-level edit of a tree by path, discriminated by `op`. Changes apply in order.',
  examples: [{ op: 'remove', path: 'content/old.md' }],
});

/** A tree change, inferred from {@link TreeChange}. */
export type TreeChange = z.infer<typeof TreeChange>;

/** Input of editTree. */
export const EditTreeInput = z
  .object({
    tree: Sha.nullable().describe('Id of the root tree to edit; null starts from an empty tree.'),
    changes: z.array(TreeChange).max(10_000).describe('Edits to apply in order; at most 10000.'),
  })
  .strict()
  .meta({
    id: 'EditTreeInput',
    title: 'editTree input',
    description: 'A root tree and the path edits to apply to it.',
    examples: [
      { tree: EMPTY_TREE, changes: [{ op: 'set', path: 'a.txt', mode: '100644', sha: EMPTY_BLOB }] },
    ],
  });

/** Input of editTree, inferred from {@link EditTreeInput}. */
export type EditTreeInput = z.infer<typeof EditTreeInput>;

/** The new root tree and the tree objects written for it. */
export const EditedTree = z
  .object({
    tree: Sha.describe('Id of the resulting root tree; equal to the input tree when nothing changed.'),
    objects: z
      .array(GitObject)
      .describe(
        'Tree objects that did not exist before, one per changed directory, deepest first. Blobs are never included.',
      ),
  })
  .strict()
  .meta({
    id: 'EditedTree',
    title: 'Edited tree',
    description:
      'The result of editing a tree: the new root id and the new tree objects. Untouched subtrees keep their ids and are not rewritten.',
    examples: [{ tree: EMPTY_TREE, objects: [] }],
  });

/** An edited tree, inferred from {@link EditedTree}. */
export type EditedTree = z.infer<typeof EditedTree>;
