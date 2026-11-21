// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

/** Reads commits one at a time by id, as `CommitGraph` does over a backend. */
export interface CommitSource {
  /** The commit with this id, or null when the repository has none. */
  commit(sha: string): Promise<Commit | null>;
}

/**
 * Orders committer dates the way the contract's reference history does: as strings. Every walk
 * that must agree with the reference compares dates with this, never with `Date.parse`.
 */
export const dateOrder = (a: Commit, b: Commit): number =>
  a.committer.date === b.committer.date ? 0 : a.committer.date > b.committer.date ? 1 : -1;
