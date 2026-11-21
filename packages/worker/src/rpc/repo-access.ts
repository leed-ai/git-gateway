// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { repoNotFound } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import type { StorageRepoInfo } from '@leed-ai/git-gateway-contract/storage/storage-repo-info';
import type { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import type { TreeReader } from '@leed-ai/git-gateway-core/tree/tree-reader';

import type { GatewayContext } from './gateway-context.ts';

/** The fully qualified ref of a branch. */
export const branchRef = (branch: string): string => `refs/heads/${branch}`;

/** The repository's description, or repo_not_found. */
export async function requireRepo(context: GatewayContext, repo: string): Promise<StorageRepoInfo> {
  const info = await context.backend.repoInfo(repo);
  if (info === null) throw repoNotFound(repo);
  return info;
}

/** The head of a branch, or null when it does not exist. */
export function branchHead(context: GatewayContext, repo: string, branch: string): Promise<string | null> {
  return context.backend.resolveRef(repo, branchRef(branch));
}

/** The head of a branch, or ref_not_found naming it. */
export async function requireBranchHead(
  context: GatewayContext,
  repo: string,
  branch: string,
): Promise<string> {
  const head = await branchHead(context, repo, branch);
  if (head === null) throw gatewayError('ref_not_found', `Branch not found: ${branch}`, { ref: branch });
  return head;
}

/** A commit the repository must have (it was named by a ref), or storage_unavailable. */
export async function requireCommit(context: GatewayContext, repo: string, sha: string): Promise<Commit> {
  const commit = await context.backend.readCommit(repo, sha);
  if (commit === null) {
    throw gatewayError('storage_unavailable', `Storage backend failed: commit ${sha} is missing`, {
      retryable: true,
    });
  }
  return commit;
}

/**
 * The commit a revision names: a 40-hex commit id is read as a commit (never a branch), anything
 * else as a branch name. Null when there is no such commit or branch.
 */
export async function resolveRevision(
  context: GatewayContext,
  repo: string,
  revision: string,
): Promise<Commit | null> {
  if (Sha.safeParse(revision).success) return context.backend.readCommit(repo, revision);
  const head = await branchHead(context, repo, revision);
  return head === null ? null : requireCommit(context, repo, head);
}

/** The commit a revision names, or ref_not_found. */
export async function requireRevision(
  context: GatewayContext,
  repo: string,
  revision: string,
): Promise<Commit> {
  const commit = await resolveRevision(context, repo, revision);
  if (commit === null) throw gatewayError('ref_not_found', `Ref not found: ${revision}`, { ref: revision });
  return commit;
}

/** A {@link TreeReader} over the repository's trees. */
export function treeReader(context: GatewayContext, repo: string): TreeReader {
  return { readTree: (sha) => context.backend.readTree(repo, sha) };
}

/**
 * The entry a path names beneath a root tree, reading one tree per segment, or null when some
 * segment is missing or a parent is not a directory.
 */
export async function entryAt(
  context: GatewayContext,
  repo: string,
  rootTree: string,
  path: string,
): Promise<StorageTreeEntry | null> {
  let tree = rootTree;
  let found: StorageTreeEntry | null = null;
  for (const segment of path.split('/')) {
    if (found !== null && found.type !== 'tree') return null;
    const entries = await context.backend.readTree(repo, tree);
    found = entries?.find((entry) => entry.name === segment) ?? null;
    if (found === null) return null;
    tree = found.sha;
  }
  return found;
}

/**
 * Whether the repository has any branch at all, read from the ref advertisement of its git
 * remote (the storage contract has no "list refs" call). Only asked when a commit names a branch
 * that does not exist, to decide between a root commit and ref_not_found.
 */
export async function hasBranches(context: GatewayContext, repo: string): Promise<boolean> {
  const remote = await context.backend.gitRemote(repo, 'read');
  const client = new GitHttpClient(remote, context.fetch === undefined ? {} : { fetch: context.fetch });
  const advertisement = await client.advertisement('git-upload-pack');
  return advertisement.refs.some((ref) => ref.name.startsWith('refs/heads/'));
}
