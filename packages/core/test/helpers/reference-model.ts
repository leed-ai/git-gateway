// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import type { FileMap, StoredFile } from '@leed-ai/git-gateway-contract/reference/file-map';
import { blobSha } from '@leed-ai/git-gateway-contract/reference/hash';

import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import type { MemoryStore, Snapshot, SnapshotFile } from './memory-store.ts';

/** A generated snapshot description (path → [content, executable]) as a store snapshot. */
export function toSnapshot(description: ReadonlyMap<string, readonly [string, boolean]>): Snapshot {
  return new Map(
    [...description].map(([path, [content, executable]]): [string, SnapshotFile] => [
      path,
      { content: utf8(content), mode: executable ? '100755' : '100644' },
    ]),
  );
}

/** The same snapshot as the contract reference model's file map. */
export async function toFileMap(
  description: ReadonlyMap<string, readonly [string, boolean]>,
): Promise<FileMap> {
  const files = new Map<string, StoredFile>();
  for (const [path, [content, executable]] of description) {
    const bytes = utf8(content);
    files.set(path, { bytes, executable, sha: await blobSha(bytes) });
  }
  return files;
}

/** A flattened git tree in the comparable form path → "<mode> <sha>". */
export function treeSignature(files: ReadonlyMap<string, GitTreeEntry>): Map<string, string> {
  return new Map([...files].map(([path, entry]) => [path, `${entry.mode} ${entry.sha}`]));
}

/** A reference file map in the same comparable form. */
export function fileMapSignature(files: FileMap): Map<string, string> {
  return new Map(
    [...files].map(([path, file]) => [path, `${file.executable ? '100755' : '100644'} ${file.sha}`]),
  );
}

/** Flattens a tree of the store into its comparable form. */
export async function flattenSignature(store: MemoryStore, tree: string): Promise<Map<string, string>> {
  return treeSignature(await store.flatten(tree));
}
