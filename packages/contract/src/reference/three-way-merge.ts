// SPDX-License-Identifier: Apache-2.0
import { byteOrder } from './bytes.ts';
import { parentDirectories, sameFile, type FileMap, type StoredFile } from './file-map.ts';

/** The result of a file-level three-way merge. */
export type MergeResult =
  | { readonly kind: 'merged'; readonly files: FileMap }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] };

/**
 * Merges two snapshots file by file against their merge base. A path changed on only one side
 * takes that side; a path changed identically on both takes either; a path changed differently on
 * both sides is a conflict, as is a file on one side where the merged result has a directory.
 */
export function threeWayMerge(base: FileMap, ours: FileMap, theirs: FileMap): MergeResult {
  const merged = new Map<string, StoredFile>();
  const conflicts = new Set<string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let pick: StoredFile | undefined;
    if (sameFile(o, t) || sameFile(t, b)) pick = o;
    else if (sameFile(o, b)) pick = t;
    else {
      conflicts.add(path);
      continue;
    }
    if (pick !== undefined) merged.set(path, pick);
  }
  for (const path of merged.keys()) {
    for (const parent of parentDirectories(path)) {
      if (merged.has(parent) || conflicts.has(parent)) {
        conflicts.add(parent);
        conflicts.add(path);
      }
    }
  }
  if (conflicts.size > 0) return { kind: 'conflict', paths: [...conflicts].toSorted(byteOrder) };
  return { kind: 'merged', files: merged };
}
