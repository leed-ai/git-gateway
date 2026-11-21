// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput, RpcParsedInput } from '@leed-ai/git-gateway-contract/git-gateway';
import { byteOrder, encodeContent } from '@leed-ai/git-gateway-contract/reference/bytes';
import type { TreeEntry } from '@leed-ai/git-gateway-contract/schemas/tree-entry';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';

import { CommitGraph } from './commit-graph.ts';
import type { GatewayContext } from './gateway-context.ts';
import { historyPage } from './history-page.ts';
import { branchHead, entryAt, requireRevision, resolveRevision } from './repo-access.ts';

const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** readFile(): the file at a path, or null when the path is absent or not a file. */
export async function gatewayReadFile(
  context: GatewayContext,
  { repo, ref, path, encoding }: RpcParsedInput<'readFile'>,
): Promise<RpcOutput<'readFile'>> {
  const commit = await requireRevision(context, repo, ref);
  const entry = await entryAt(context, repo, commit.tree, path);
  if (entry === null || entry.type !== 'blob') return null;
  const data = await context.backend.readBlob(repo, entry.sha);
  if (data === null) throw storageUnavailable(`read ${path}`, `blob ${entry.sha} is missing`);
  return {
    path,
    commit: commit.sha,
    sha: entry.sha,
    size: data.length,
    executable: entry.mode === '100755',
    ...encodeContent(data, encoding),
  };
}

/** Every entry beneath a tree, one level or all levels, with full paths, sorted in byte order. */
async function listEntries(
  context: GatewayContext,
  repo: string,
  tree: string,
  dir: string,
  recursive: boolean,
): Promise<TreeEntry[]> {
  const listed: TreeEntry[] = [];
  let pending = [{ sha: tree, path: dir }];
  while (pending.length > 0) {
    const levels = await Promise.all(
      pending.map(async (at) => ({ at, entries: await context.backend.readTree(repo, at.sha) })),
    );
    pending = [];
    for (const { at, entries } of levels) {
      for (const entry of entries ?? []) {
        const path = join(at.path, entry.name);
        listed.push({ ...entry, path });
        if (recursive && entry.type === 'tree') pending.push({ sha: entry.sha, path });
      }
    }
  }
  return listed.toSorted((a, b) => byteOrder(a.path, b.path));
}

/** listTree(): a directory listing, or null when the path is absent or not a directory. */
export async function gatewayListTree(
  context: GatewayContext,
  { repo, ref, path, recursive }: RpcParsedInput<'listTree'>,
): Promise<RpcOutput<'listTree'>> {
  const commit = await requireRevision(context, repo, ref);
  let tree = commit.tree;
  if (path !== undefined) {
    const entry = await entryAt(context, repo, commit.tree, path);
    if (entry === null || entry.type !== 'tree') return null;
    tree = entry.sha;
  }
  return {
    commit: commit.sha,
    path: path ?? null,
    entries: await listEntries(context, repo, tree, path ?? '', recursive),
  };
}

/** resolveRef(): the commit a branch or commit id names, or null. */
export async function gatewayResolveRef(
  context: GatewayContext,
  { repo, ref }: RpcParsedInput<'resolveRef'>,
): Promise<RpcOutput<'resolveRef'>> {
  const commit = await resolveRevision(context, repo, ref);
  return commit === null ? null : { sha: commit.sha };
}

/**
 * log(): a page of the history reachable from a revision, in the reference's order (newest
 * committer date first, never a parent before its child), reading only as far back as the page
 * needs (see {@link historyPage}).
 */
export async function gatewayLog(
  context: GatewayContext,
  { repo, ref, limit, offset, since }: RpcParsedInput<'log'>,
): Promise<RpcOutput<'log'>> {
  const start = await requireRevision(context, repo, ref);
  return historyPage(new CommitGraph(context, repo), start, { limit, offset, since });
}

/** commitExists(): whether the commit exists, and is reachable from `branch` when one is named. */
export async function gatewayCommitExists(
  context: GatewayContext,
  { repo, sha, branch }: RpcParsedInput<'commitExists'>,
): Promise<RpcOutput<'commitExists'>> {
  const graph = new CommitGraph(context, repo);
  if ((await graph.commit(sha)) === null) return { exists: false };
  if (branch === undefined) return { exists: true };
  const head = await branchHead(context, repo, branch);
  return { exists: head !== null && (await graph.contains(head, sha)) };
}
