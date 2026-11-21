// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import type { CommitReader } from '../../src/idempotency/find-idempotent-commit.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import { decodeTree } from '../../src/objects/tree-object.ts';
import type { GitObject, GitTreeEntry } from '../../src/schemas/git-object.ts';
import type { TreeChange } from '../../src/schemas/tree-edit.ts';
import { editTree } from '../../src/tree/edit-tree.ts';
import type { TreeReader } from '../../src/tree/tree-reader.ts';

/** A file of a flattened snapshot: content and mode. */
export interface SnapshotFile {
  readonly content: Uint8Array;
  readonly mode: '100644' | '100755' | '120000';
}

/** A flattened snapshot: every file by full path. */
export type Snapshot = ReadonlyMap<string, SnapshotFile>;

const encoder = new TextEncoder();

/** A text file of a snapshot. */
export const textFile = (text: string, mode: SnapshotFile['mode'] = '100644'): SnapshotFile => ({
  content: encoder.encode(text),
  mode,
});

/** An in-memory git object store that serves trees and commits and counts tree reads. */
export class MemoryStore implements TreeReader, CommitReader {
  readonly objects = new Map<string, GitObject>();
  readonly commits = new Map<string, Commit>();
  readonly treeReads: string[] = [];

  put(objects: readonly GitObject[]): void {
    for (const object of objects) this.objects.set(object.sha, object);
  }

  putCommit(commit: Commit): void {
    this.commits.set(commit.sha, commit);
  }

  async readTree(sha: string): Promise<readonly GitTreeEntry[] | null> {
    this.treeReads.push(sha);
    const object = this.objects.get(sha);
    return object?.type === 'tree' ? decodeTree(object.data, sha) : null;
  }

  async readCommit(sha: string): Promise<Commit | null> {
    return this.commits.get(sha) ?? null;
  }

  /** Stores a snapshot's blobs and trees and returns its root tree id. */
  async writeSnapshot(snapshot: Snapshot): Promise<string> {
    const changes: TreeChange[] = [];
    for (const [path, file] of snapshot) {
      const blob = await createObject('blob', file.content);
      this.put([blob]);
      changes.push({ op: 'set', path, mode: file.mode, sha: blob.sha });
    }
    const edited = await editTree({ tree: null, changes }, this);
    this.put(edited.objects);
    return edited.tree;
  }

  /** Every file beneath a tree, flattened, with blob ids and modes. */
  async flatten(tree: string, prefix = ''): Promise<Map<string, GitTreeEntry>> {
    const files = new Map<string, GitTreeEntry>();
    const object = this.objects.get(tree);
    if (object === undefined) {
      if (tree === '4b825dc642cb6eb9a060e54bf8d69288fbee4904') return files;
      throw new Error(`missing tree ${tree}`);
    }
    for (const entry of decodeTree(object.data, tree)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '040000') for (const [p, e] of await this.flatten(entry.sha, path)) files.set(p, e);
      else files.set(path, entry);
    }
    return files;
  }

  /** The bytes of a stored blob. */
  blob(sha: string): Uint8Array {
    const object = this.objects.get(sha);
    if (object?.type !== 'blob') throw new Error(`missing blob ${sha}`);
    return object.data;
  }
}
