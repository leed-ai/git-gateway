// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

import { TreeEntry } from '../schemas/tree-entry.ts';

/** One entry of a tree object read by id. */
export const StorageTreeEntry = TreeEntry.omit({ path: true })
  .strict()
  .meta({
    id: 'StorageTreeEntry',
    title: 'Storage tree entry',
    description:
      'One entry of a git tree object read by its id through StorageBackend.readTree(): the name within that tree, the kind of object, its mode and its id. A contract TreeEntry without the path, which a tree read by id cannot know. Entries come back in the order git stores them.',
    examples: [
      { name: 'about.md', type: 'blob', mode: '100644', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' },
    ],
  });

/** A tree entry read by tree id, inferred from {@link StorageTreeEntry}. */
export type StorageTreeEntry = z.infer<typeof StorageTreeEntry>;
