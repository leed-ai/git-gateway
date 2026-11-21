// SPDX-License-Identifier: Apache-2.0
import { readIdempotencyTrailer } from '@leed-ai/git-gateway-contract/reference/trailer';
import { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { encodeCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { hashObject } from '@leed-ai/git-gateway-core/objects/hash-object';

import type { ArtifactsCommit, ArtifactsTreeEntry } from './schemas/artifacts-binding-results.ts';

const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** The contract commit for some Artifacts commit metadata, with a given full message. */
function commitWith(metadata: ArtifactsCommit, message: string): Commit {
  return Commit.parse({
    sha: metadata.hash,
    tree: metadata.treeHash,
    parents: metadata.parents,
    author: { ...metadata.author, date: isoOf(metadata.authoredAt) },
    committer: { ...metadata.committer, date: isoOf(metadata.committedAt) },
    message,
    idempotencyKey: readIdempotencyTrailer(message),
  });
}

/**
 * Converts Artifacts commit metadata into a contract {@link Commit}. Artifacts removes one
 * trailing newline from the message and reports dates without their time zone, so the full
 * message is recovered by re-encoding the commit both ways (at +0000, as the gateway writes
 * every commit) and keeping the candidate whose id matches. When neither matches (a commit made
 * in another time zone, or with extra headers such as a signature) the message is given back
 * with the trailing newline git itself always writes.
 */
export async function toContractCommit(metadata: ArtifactsCommit): Promise<Commit> {
  const candidates = [`${metadata.message}\n`, metadata.message].filter((message) => message.length > 0);
  for (const message of candidates) {
    const commit = commitWith(metadata, message);
    const { tree, parents, author, committer } = commit;
    const sha = await hashObject(
      'commit',
      encodeCommit({ tree, parents: [...parents], author, committer, message }),
    );
    if (sha === metadata.hash) return commit;
  }
  return commitWith(metadata, `${metadata.message}\n`);
}

const TYPES = { tree: 'tree', gitlink: 'commit', blob: 'blob', exec: 'blob', symlink: 'blob' } as const;

/** Converts an Artifacts tree entry into a contract {@link StorageTreeEntry} (mode "40000" becomes "040000"). */
export function toStorageTreeEntry(entry: ArtifactsTreeEntry): StorageTreeEntry {
  return StorageTreeEntry.parse({
    name: entry.name,
    type: TYPES[entry.type],
    mode: entry.mode === '40000' ? '040000' : entry.mode,
    sha: entry.hash,
  });
}
