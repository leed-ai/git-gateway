// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { decodeCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { decodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import type { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

const KIND_OF_MODE = { '040000': 'tree', '160000': 'commit' } as const;

/**
 * Fetches exactly the named objects over git: each want with one generation of history and a
 * partial-clone filter that leaves out everything below it ("tree:0" for commits — the commit
 * objects alone; "tree:1" for a tree — that tree alone). Returns null only when the server refuses
 * a want in-protocol (an "ERR" pkt-line in an HTTP 200 answer: an unknown id), so the caller can
 * tell a missing object from a failure. An HTTP failure (remote_http_error: an outage, an expired
 * token) propagates, so the backend reports it as storage_unavailable.
 */
async function fetchExact(
  client: GitHttpClient,
  wants: readonly string[],
  filter: 'tree:0' | 'tree:1',
): Promise<Map<string, GitObject> | null> {
  try {
    const { objects } = await client.fetchPack({ wants: [...wants], depth: 1, filter });
    return new Map(objects.map((object) => [object.sha, object]));
  } catch (error) {
    if (isCoreError(error, 'remote_error')) return null;
    throw error;
  }
}

/**
 * The commit objects for `shas`, decoded exactly as stored (GitLab's Commits API reports neither
 * the tree id nor the raw message, so they are read from the objects themselves). Throws when the
 * server does not send one of them.
 */
export async function readCommitsOverGit(client: GitHttpClient, shas: readonly string[]): Promise<Commit[]> {
  if (shas.length === 0) return [];
  const objects = await fetchExact(client, shas, 'tree:0');
  return shas.map((sha) => {
    const object = objects?.get(sha);
    if (object?.type !== 'commit') throw new Error(`GitLab did not send commit ${sha}`);
    return decodeCommit(sha, object.data);
  });
}

/** One level of the tree `sha`, read over git; null when the server has no such object or it is not a tree. */
export async function readTreeOverGit(
  client: GitHttpClient,
  sha: string,
): Promise<StorageTreeEntry[] | null> {
  const object = (await fetchExact(client, [sha], 'tree:1'))?.get(sha);
  if (object?.type !== 'tree') return null;
  return decodeTree(object.data, sha).map((entry) =>
    StorageTreeEntry.parse({
      ...entry,
      type: entry.mode === '040000' || entry.mode === '160000' ? KIND_OF_MODE[entry.mode] : 'blob',
    }),
  );
}
