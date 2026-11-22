// SPDX-License-Identifier: Apache-2.0
import type { GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { z } from 'zod';

import type { ArtifactsRepoHandle } from './artifacts-binding.ts';
import { isWrongKind } from './artifacts-errors.ts';
import { ArtifactsCommit, ArtifactsTreeEntry } from './schemas/artifacts-binding-results.ts';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Whether a binding call failed only because its result, a Blob, could not be carried back. That
 * is what wrangler's remote Artifacts binding (`"remote": true` under `wrangler dev`) does for
 * readBlob and readFile: its proxy cannot serialize a Blob ("Cannot serialize value: [object
 * Blob]"). The native binding in production returns the Blob and never takes this path.
 */
export function isUnserializableBlob(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null) return false;
  const message: unknown = Reflect.get(thrown, 'message');
  return typeof message === 'string' && message.includes('Cannot serialize value: [object Blob]');
}

/**
 * A blob's bytes read over the repository's git remote instead of the binding: one upload-pack
 * request wanting just that id (a blob reaches nothing, so the pack holds that object alone),
 * read with the core pack reader. Null when the server does not have the id (refused
 * in-protocol, "not our ref") or it is not a blob. HTTP failures propagate.
 */
export async function readBlobOverGit(remote: GitRemote, sha: string): Promise<Uint8Array | null> {
  try {
    const { objects } = await new GitHttpClient(remote).fetchPack({ wants: [sha] });
    const object = objects.find((candidate) => candidate.sha === sha);
    return object?.type === 'blob' ? object.data : null;
  } catch (error) {
    if (isCoreError(error, 'remote_error')) return null;
    throw error;
  }
}

/**
 * The id of the blob at `path` in `revision` (a commit id or a short branch name), found through
 * the binding's own commit and tree reads, which carry plain data even where Blobs cannot travel.
 * Null when the revision, a directory on the way or the file does not exist, the revision names a
 * tree or a blob, or the path names a directory or submodule.
 */
export async function blobIdAt(
  handle: ArtifactsRepoHandle,
  revision: string,
  path: string,
): Promise<string | null> {
  let commitId: string | null = revision;
  if (!SHA.test(revision)) {
    const [head] = z.array(ArtifactsCommit).parse(await handle.log({ ref: revision, limit: 1 }));
    commitId = head?.hash ?? null;
  }
  if (commitId === null) return null;
  const found = commitId;
  const commit = await handle.readCommit(found).catch((error: unknown) => {
    // A revision naming a tree or a blob is a revision that does not exist.
    if (isWrongKind(error, found)) return null;
    throw error;
  });
  if (commit === null) return null;
  let tree = ArtifactsCommit.parse(commit).treeHash;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    const listed = await handle.readTree(tree);
    if (listed === null) return null;
    const entry = z
      .array(ArtifactsTreeEntry)
      .parse(listed)
      .find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    const last = index === segments.length - 1;
    if (last) return entry.type === 'tree' || entry.type === 'gitlink' ? null : entry.hash;
    if (entry.type !== 'tree') return null;
    tree = entry.hash;
  }
  return null;
}
