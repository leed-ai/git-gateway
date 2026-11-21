// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import type { CommitSource } from './commit-source.ts';
import type { GatewayContext } from './gateway-context.ts';
import { isAncestor, mergeBaseOf } from './paint-down.ts';

/**
 * The commits of one repository, read through the backend on demand and kept for the duration of
 * one call (commits are immutable, so the cache can never go stale). Ancestry questions are
 * answered with git's paint-down walk, which reads only the history between the commits asked
 * about and their merge base — never the whole history of a branch.
 */
export class CommitGraph implements CommitSource {
  readonly #context: GatewayContext;
  readonly #repo: string;
  readonly #commits = new Map<string, Promise<Commit | null>>();

  constructor(context: GatewayContext, repo: string) {
    this.#context = context;
    this.#repo = repo;
  }

  /** The commit with this id, or null when the repository has none; each id is read once. */
  commit(sha: string): Promise<Commit | null> {
    let read = this.#commits.get(sha);
    if (read === undefined) {
      read = this.#context.backend.readCommit(this.#repo, sha);
      this.#commits.set(sha, read);
      read.catch(() => this.#commits.delete(sha));
    }
    return read;
  }

  /** True when `ancestor` is reachable from `descendant` (a commit contains itself). */
  contains(descendant: string, ancestor: string): Promise<boolean> {
    return isAncestor(this, descendant, ancestor);
  }

  /** The reference's merge base of two commits, or null when their histories are unrelated. */
  mergeBase(a: string, b: string): Promise<string | null> {
    return mergeBaseOf(this, a, b);
  }
}
