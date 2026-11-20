// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { FilePath } from './names.ts';
import { Sha } from './sha.ts';

/** The git file mode of a tree entry. */
export const FileMode = z.enum(['100644', '100755', '120000', '040000', '160000']).meta({
  id: 'FileMode',
  title: 'File mode',
  description: 'The git mode of a tree entry, as the six-digit octal string git records.',
  enumDescriptions: {
    '100644': 'A regular file, not executable.',
    '100755': 'A regular file with the executable bit set.',
    '120000': 'A symbolic link; the blob holds the link target.',
    '040000': 'A directory (a subtree).',
    '160000': 'A submodule; the id names a commit in another repository.',
  },
  examples: ['100644', '040000'],
});

/** A git file mode, inferred from {@link FileMode}. */
export type FileMode = z.infer<typeof FileMode>;

/** The kind of object a tree entry names. */
export const TreeEntryType = z.enum(['blob', 'tree', 'commit']).meta({
  id: 'TreeEntryType',
  title: 'Tree entry type',
  description: 'The kind of object a tree entry names.',
  enumDescriptions: {
    blob: 'A file or symbolic link (modes 100644, 100755, 120000).',
    tree: 'A directory (mode 040000).',
    commit: 'A submodule commit in another repository (mode 160000).',
  },
  examples: ['blob', 'tree'],
});

/** A tree entry type, inferred from {@link TreeEntryType}. */
export type TreeEntryType = z.infer<typeof TreeEntryType>;

/** One entry of a directory listing. */
export const TreeEntry = z
  .object({
    path: FilePath.describe('Full path of the entry from the repository root.'),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\0]+$/)
      .describe('Last segment of the path: 1–255 characters without "/" or NUL.'),
    type: TreeEntryType,
    mode: FileMode,
    sha: Sha.describe('Id of the blob, tree or submodule commit the entry names.'),
  })
  .strict()
  .meta({
    id: 'TreeEntry',
    title: 'Tree entry',
    description: 'One entry of a directory listing: a file, directory, symbolic link or submodule.',
    examples: [
      {
        path: 'content/about.md',
        name: 'about.md',
        type: 'blob',
        mode: '100644',
        sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      },
    ],
  });

/** A tree entry, inferred from {@link TreeEntry}. */
export type TreeEntry = z.infer<typeof TreeEntry>;
