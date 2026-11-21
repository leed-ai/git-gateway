// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '../schemas/commit.ts';
import type { Identity } from '../schemas/identity.ts';
import type { FileMap } from './file-map.ts';
import { modelSha } from './hash.ts';
import type { RepoState, StoredCommit } from './repo-state.ts';
import { readIdempotencyTrailer } from './trailer.ts';
import { buildTreeIndex } from './tree-index.ts';

/** What a new commit records. */
export interface NewCommit {
  readonly parents: readonly string[];
  readonly files: FileMap;
  readonly author: Identity;
  readonly committer: Identity;
  readonly message: string;
  readonly date: string;
}

/** Builds a commit from a snapshot, stores it in the repository and returns it. Moves no branch. */
export async function writeCommit(repo: RepoState, next: NewCommit): Promise<StoredCommit> {
  const tree = await buildTreeIndex(next.files);
  const author = { name: next.author.name, email: next.author.email, date: next.date };
  const committer = { name: next.committer.name, email: next.committer.email, date: next.date };
  const canonical = JSON.stringify({
    tree: tree.rootSha,
    parents: next.parents,
    author,
    committer,
    message: next.message,
  });
  const commit: Commit = {
    sha: await modelSha('commit', canonical),
    tree: tree.rootSha,
    parents: [...next.parents],
    author,
    committer,
    message: next.message,
    idempotencyKey: readIdempotencyTrailer(next.message),
  };
  const stored = { commit, files: next.files, tree };
  repo.commits.set(commit.sha, stored);
  return stored;
}
