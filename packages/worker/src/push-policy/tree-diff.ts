// SPDX-License-Identifier: Apache-2.0
import type { ChangedPath } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { GitTreeEntry } from '@leed-ai/git-gateway-core/schemas/git-object';

import { Uncheckable } from './uncheckable.ts';

/** A changed path before its size is known. */
export type TreeChange = Omit<ChangedPath, 'size'>;

/** Where tree entries come from; throws {@link Uncheckable} for a tree it cannot find. */
export type TreeLookup = (sha: string) => Promise<readonly GitTreeEntry[]>;

/** Longest path a ChangedPath may carry. */
const MAX_PATH = 4096;
const TREE_MODE = '040000';

/** Collects changes, refusing more than `limit` of them across every diff it is used for. */
export class ChangeSink {
  readonly #limit: number;
  #count = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Counts one more change; throws {@link Uncheckable} past the limit. */
  take(change: TreeChange, into: TreeChange[]): void {
    this.#count += 1;
    if (this.#count > this.#limit) throw new Uncheckable(`it changes more than ${this.#limit} paths`);
    if (change.path.length > MAX_PATH) throw new Uncheckable(`a path is longer than ${MAX_PATH} characters`);
    into.push(change);
  }
}

const added = (path: string, entry: GitTreeEntry): TreeChange => ({
  path,
  change: 'added',
  oldMode: null,
  newMode: entry.mode,
  oldSha: null,
  newSha: entry.sha,
});

const deleted = (path: string, entry: GitTreeEntry): TreeChange => ({
  path,
  change: 'deleted',
  oldMode: entry.mode,
  newMode: null,
  oldSha: entry.sha,
  newSha: null,
});

/**
 * The files that differ between two trees (null for the empty tree), recursing only into subtrees
 * whose ids differ, so the cost is proportional to what changed. A directory added or removed
 * yields each file in it; an entry that turns from a file into a directory (or back) is the file
 * deleted (or added) plus the directory's files. A mode change alone is "modified".
 */
export async function diffTrees(
  lookup: TreeLookup,
  oldTree: string | null,
  newTree: string | null,
  sink: ChangeSink,
  prefix = '',
): Promise<TreeChange[]> {
  const changes: TreeChange[] = [];
  if (oldTree === newTree) return changes;
  const before = new Map((oldTree === null ? [] : await lookup(oldTree)).map((entry) => [entry.name, entry]));
  const after = new Map((newTree === null ? [] : await lookup(newTree)).map((entry) => [entry.name, entry]));
  const names = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  for (const name of names) {
    const old = before.get(name);
    const current = after.get(name);
    if (old?.sha === current?.sha && old?.mode === current?.mode) continue;
    const path = `${prefix}${name}`;
    const oldIsTree = old?.mode === TREE_MODE;
    const newIsTree = current?.mode === TREE_MODE;
    if (oldIsTree || newIsTree) {
      const nested = await diffTrees(
        lookup,
        oldIsTree ? (old?.sha ?? null) : null,
        newIsTree ? (current?.sha ?? null) : null,
        sink,
        `${path}/`,
      );
      changes.push(...nested);
      if (old !== undefined && !oldIsTree) sink.take(deleted(path, old), changes);
      if (current !== undefined && !newIsTree) sink.take(added(path, current), changes);
      continue;
    }
    if (old !== undefined && current !== undefined) {
      sink.take(
        {
          path,
          change: 'modified',
          oldMode: old.mode,
          newMode: current.mode,
          oldSha: old.sha,
          newSha: current.sha,
        },
        changes,
      );
    } else if (old !== undefined) sink.take(deleted(path, old), changes);
    else if (current !== undefined) sink.take(added(path, current), changes);
  }
  return changes;
}
