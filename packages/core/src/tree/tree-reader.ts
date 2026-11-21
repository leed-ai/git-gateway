// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { coreError } from '../core-error.ts';
import { GitTreeEntry } from '../schemas/git-object.ts';

/** The id of the empty tree, which every git repository can name without storing it. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Reads one level of a tree by id, the way `StorageBackend.readTree` does. */
export interface TreeReader {
  /**
   * The direct entries of the tree with this id, or null when the repository has no such tree.
   * Contract TreeEntry objects are accepted; only `name`, `mode` and `sha` are read.
   */
  readTree(sha: string): Promise<readonly GitTreeEntry[] | null>;
}

const Entries = z.array(GitTreeEntry);

/**
 * The entries of a tree, read through `reader` and parsed. The empty tree is answered without a
 * read. Throws a missing_object CoreError when the reader has no such tree and invalid_object
 * when what it returns is not a valid entry list.
 */
export async function loadTree(reader: TreeReader, sha: string): Promise<GitTreeEntry[]> {
  if (sha === EMPTY_TREE_SHA) return [];
  const entries = await reader.readTree(sha);
  if (entries === null) throw coreError('missing_object', `Tree not found: ${sha}`, { sha, type: 'tree' });
  const parsed = Entries.safeParse(entries.map(({ name, mode, sha: id }) => ({ name, mode, sha: id })));
  if (!parsed.success) {
    throw coreError('invalid_object', `Invalid tree: ${sha}`, {
      sha,
      type: 'tree',
      reason: parsed.error.issues[0]?.message ?? 'invalid entries',
    });
  }
  return parsed.data;
}
