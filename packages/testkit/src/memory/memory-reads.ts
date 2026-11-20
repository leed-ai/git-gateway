// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import type { MemoryRepository } from './memory-repository.ts';

const SHA = /^[0-9a-f]{40}$/;

/** The commit a revision names: a commit id as is, otherwise the branch "refs/heads/<name>". */
export function resolveRevision(repo: MemoryRepository, revision: string): string | null {
  if (SHA.test(revision)) return repo.object(revision, 'commit') === null ? null : revision;
  return repo.refs.get(`refs/heads/${revision}`) ?? null;
}

/** The blob at `path` beneath a commit's tree, or null when there is no file there. */
export function fileAt(repo: MemoryRepository, commitSha: string, path: string): Uint8Array | null {
  const commit = repo.commit(commitSha);
  if (commit === null) return null;
  let tree = commit.tree;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    const entry = repo.tree(tree)?.find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return entry.mode === '040000' || entry.mode === '160000'
        ? null
        : (repo.object(entry.sha, 'blob')?.data ?? null);
    }
    if (entry.mode !== '040000') return null;
    tree = entry.sha;
  }
  return null;
}

/** The first-parent chain from a commit, newest first: `offset` skipped, then up to `limit`. */
export function firstParentLog(
  repo: MemoryRepository,
  start: string,
  limit: number,
  offset: number,
): Commit[] {
  const out: Commit[] = [];
  let index = 0;
  let next: string | undefined = start;
  while (next !== undefined && out.length < limit) {
    const commit = repo.commit(next);
    if (commit === null) break;
    if (index >= offset) out.push(commit);
    index += 1;
    next = commit.parents[0];
  }
  return out;
}
