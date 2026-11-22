// SPDX-License-Identifier: Apache-2.0
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { commitHeaderLines, readCommitParents } from '@leed-ai/git-gateway-core/objects/commit-parents';
import { hashObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { encodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';
import { readPack } from '@leed-ai/git-gateway-core/pack/read-pack';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';

import { Uncheckable, type ReadBudget } from './uncheckable.ts';

/** A commit of the pushed pack: its tree, and its parents as git reads them (null: unreadable). */
export interface PackCommit {
  readonly tree: string;
  readonly parents: readonly string[] | null;
}

/** The objects of a pushed pack, indexed for computing changed paths. */
export interface PushedObjects {
  readonly commits: ReadonlyMap<string, PackCommit>;
  /** Tree objects' content by id. */
  readonly trees: ReadonlyMap<string, Uint8Array>;
  /** Blob sizes by id. */
  readonly blobSizes: ReadonlyMap<string, number>;
}

/** Where a pushed pack's thin-pack bases are read from, and the bounds on reading it. */
export interface PushedObjectSources {
  readonly repo: string;
  readonly backend: Pick<StorageBackend, 'readTree' | 'readBlob'>;
  readonly budget: ReadBudget;
  readonly maxObjectBytes: number;
}

/**
 * Reads a thin pack's delta base from storage: as a tree (re-encoded, and accepted only when it
 * hashes to the id asked for, so a backend's view of the tree cannot pass for different bytes)
 * or as a blob. Each storage call counts against the budget.
 */
async function lookupBase(sources: PushedObjectSources, sha: string): Promise<GitObject | null> {
  sources.budget.spend();
  const entries = await sources.backend.readTree(sources.repo, sha);
  if (entries !== null) {
    const data = encodeTree(entries.map(({ name, mode, sha: id }) => ({ name, mode, sha: id })));
    return (await hashObject('tree', data)) === sha ? { type: 'tree', sha, data } : null;
  }
  sources.budget.spend();
  const blob = await sources.backend.readBlob(sources.repo, sha);
  if (blob === null || (await hashObject('blob', blob)) !== sha) return null;
  return { type: 'blob', sha, data: blob };
}

/**
 * Reads a whole pushed pack (its checksum verified) into commits, trees and blob sizes, resolving
 * deltas against objects in the pack and thin-pack bases in storage. Throws {@link Uncheckable}
 * when the pack is malformed, needs more than `maxObjectBytes` or more storage reads than the
 * budget allows, or names a base storage does not have.
 */
export async function readPushedObjects(
  pack: Uint8Array,
  sources: PushedObjectSources,
): Promise<PushedObjects> {
  let objects: GitObject[];
  try {
    objects = await readPack(pack, {
      maxObjectBytes: sources.maxObjectBytes,
      lookupBase: async (sha) => lookupBase(sources, sha),
    });
  } catch (error) {
    if (error instanceof Uncheckable) throw error;
    if (isCoreError(error, 'unsupported_request'))
      throw new Uncheckable(`it needs more than ${sources.maxObjectBytes} bytes of objects`);
    if (isCoreError(error)) throw new Uncheckable(`the pushed pack could not be read (${error.message})`);
    throw error;
  }
  const commits = new Map<string, PackCommit>();
  const trees = new Map<string, Uint8Array>();
  const blobSizes = new Map<string, number>();
  for (const object of objects) {
    if (object.type === 'tree') trees.set(object.sha, object.data);
    else if (object.type === 'blob') blobSizes.set(object.sha, object.data.length);
    else {
      const header = commitHeaderLines(new TextDecoder().decode(object.data));
      commits.set(object.sha, { tree: (header[0] ?? '').slice(5), parents: readCommitParents(header) });
    }
  }
  return { commits, trees, blobSizes };
}
