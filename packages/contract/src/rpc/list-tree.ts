// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { FilePath, RepoName, Revision } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';
import { TreeEntry } from '../schemas/tree-entry.ts';

/** Input of `listTree`. */
export const ListTreeInput = z
  .object({
    repo: RepoName.describe('Repository to read from.'),
    ref: Revision.describe('Branch name or commit id to list at.'),
    path: FilePath.optional().describe('Directory to list. Absent: the repository root.'),
    recursive: z
      .boolean()
      .default(false)
      .describe(
        'true lists every entry beneath the directory (directories included); false (default) one level.',
      ),
  })
  .strict()
  .meta({
    id: 'ListTreeInput',
    title: 'listTree input',
    description:
      'Input of listTree(): a directory listing at a branch or commit. Fails with ref_not_found if the ref is missing.',
    examples: [{ repo: 'acme-raw-content', ref: 'main', path: 'content', recursive: false }],
  });

/** Input of `listTree` as accepted (defaults optional). */
export type ListTreeInput = z.input<typeof ListTreeInput>;

/** A directory listing. */
export const TreeListing = z
  .object({
    commit: Sha.describe('Id of the commit listed (the ref resolved).'),
    path: FilePath.nullable().describe('The directory listed; null for the repository root.'),
    entries: z
      .array(TreeEntry)
      .describe('Entries sorted by full path in byte order; empty for a repository root with no files.'),
  })
  .strict()
  .meta({
    id: 'TreeListing',
    title: 'Tree listing',
    description: 'A directory listing at a commit.',
    examples: [
      {
        commit: EXAMPLE_SHA_B,
        path: 'content',
        entries: [
          {
            path: 'content/about.md',
            name: 'about.md',
            type: 'blob',
            mode: '100644',
            sha: 'f2a5b0a7d1d3d1f1c1c3e7e5d2b9b7e1a3c5d7e9',
          },
        ],
      },
    ],
  });

/** A directory listing, inferred from {@link TreeListing}. */
export type TreeListing = z.infer<typeof TreeListing>;

/** Output of `listTree`: the listing, or null when the path is not a directory. */
export const ListTreeOutput = TreeListing.nullable().meta({
  id: 'ListTreeOutput',
  title: 'listTree output',
  description:
    'Output of listTree(): the listing, or null when the path is not a directory at that ref (absent or a file).',
  examples: [null],
});

/** Output of `listTree`, inferred from {@link ListTreeOutput}. */
export type ListTreeOutput = z.infer<typeof ListTreeOutput>;
