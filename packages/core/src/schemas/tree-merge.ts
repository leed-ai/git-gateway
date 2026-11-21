// SPDX-License-Identifier: Apache-2.0
import { FilePath } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { GitObject } from './git-object.ts';

const BASE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OURS = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const THEIRS = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** Input of mergeTrees. */
export const MergeTreesInput = z
  .object({
    base: Sha.describe('Root tree of the merge base commit.'),
    ours: Sha.describe('Root tree of the branch being brought up to date (`into`).'),
    theirs: Sha.describe('Root tree of the branch being merged in (`from`).'),
  })
  .strict()
  .meta({
    id: 'MergeTreesInput',
    title: 'mergeTrees input',
    description: 'The three root trees of a file-level three-way merge: merge base, ours and theirs.',
    examples: [{ base: BASE, ours: OURS, theirs: THEIRS }],
  });

/** Input of mergeTrees, inferred from {@link MergeTreesInput}. */
export type MergeTreesInput = z.infer<typeof MergeTreesInput>;

/** The trees merged cleanly. */
export const TreesMerged = z
  .object({
    status: z.literal('merged').describe('Every path merged without conflict.'),
    tree: Sha.describe('Id of the merged root tree.'),
    objects: z
      .array(GitObject)
      .describe('Tree objects the merged tree needs that none of the three inputs had, deepest first.'),
  })
  .strict()
  .meta({
    id: 'TreesMerged',
    title: 'Trees merged',
    description:
      'The merge succeeded: each path changed on one side took that side, and paths changed identically on both took either.',
    examples: [{ status: 'merged', tree: THEIRS, objects: [] }],
  });

/** Some paths conflict. */
export const TreesConflict = z
  .object({
    status: z.literal('conflict').describe('Some paths cannot be merged at file level.'),
    paths: z
      .array(FilePath.describe('A conflicting path.'))
      .min(1)
      .describe(
        'Every conflicting path, sorted in byte order: changed differently on both sides, or a file where the merged result has a directory (the file and every merged path beneath it).',
      ),
  })
  .strict()
  .meta({
    id: 'TreesConflict',
    title: 'Trees conflict',
    description: 'The merge failed: the listed paths changed differently on both sides. Nothing is written.',
    examples: [{ status: 'conflict', paths: ['content/about.md'] }],
  });

/** The outcome of a file-level three-way merge. */
export const TreeMergeResult = z.discriminatedUnion('status', [TreesMerged, TreesConflict]).meta({
  id: 'TreeMergeResult',
  title: 'Tree merge result',
  description: 'The outcome of mergeTrees, discriminated by `status`.',
  examples: [{ status: 'conflict', paths: ['content/about.md'] }],
});

/** The outcome of a tree merge, inferred from {@link TreeMergeResult}. */
export type TreeMergeResult = z.infer<typeof TreeMergeResult>;
