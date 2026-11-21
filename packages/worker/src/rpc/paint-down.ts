// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import { type CommitSource, dateOrder } from './commit-source.ts';

/** Reached from the first commit. */
const ONE = 1;
/** Reached from the second commit. */
const TWO = 2;
/** Reached through a common ancestor, so an ancestor of one: never a best common ancestor. */
const STALE = 4;
const BOTH = ONE | TWO;

/** What one paint-down walk found. */
interface Painted {
  /** True when the walk stopped because `stopAt` was reached from the second commit. */
  readonly stopped: boolean;
  /**
   * Common ancestors met before the walk ended that were not found to sit beneath another one.
   * Every best common ancestor is among them; a few non-best ones may be too.
   */
  readonly candidates: readonly Commit[];
}

/**
 * Git's paint-down-to-common walk. Both commits are walked back together, newest committer date
 * first, each commit painted with the side(s) it was reached from. A commit reached from both is a
 * common ancestor, and everything beneath it is painted stale. The walk ends once every queued
 * commit is stale: any commit not yet reached then lies beneath a common ancestor, so it can be
 * neither a best common ancestor nor on the way to one. Only the history between the two heads
 * and their merge base is read, never the whole history — unless the histories are unrelated.
 * When `stopAt` is given, the walk ends as soon as that commit is reached from the second commit.
 */
async function paintDown(
  source: CommitSource,
  one: Commit,
  two: Commit,
  stopAt: string | null,
): Promise<Painted> {
  const flags = new Map<string, number>();
  const commits = new Map<string, Commit>();
  const queue: Commit[] = [];
  const reachedBoth: Commit[] = [];
  const paint = (commit: Commit, add: number): void => {
    const had = flags.get(commit.sha) ?? 0;
    if ((had & add) === add) return;
    flags.set(commit.sha, had | add);
    commits.set(commit.sha, commit);
    if (!queue.some((queued) => queued.sha === commit.sha)) queue.push(commit);
  };
  const isStale = (commit: Commit): boolean => ((flags.get(commit.sha) ?? 0) & STALE) !== 0;
  const stopped = (): boolean => stopAt !== null && ((flags.get(stopAt) ?? 0) & TWO) !== 0;

  paint(one, ONE);
  paint(two, TWO);
  while (!stopped() && queue.some((commit) => !isStale(commit))) {
    let newest = 0;
    queue.forEach((commit, index) => {
      const best = queue[newest];
      if (best !== undefined && dateOrder(commit, best) > 0) newest = index;
    });
    const [commit] = queue.splice(newest, 1);
    if (commit === undefined) break;
    let carried = flags.get(commit.sha) ?? 0;
    if ((carried & (BOTH | STALE)) === BOTH) {
      if (!reachedBoth.some((found) => found.sha === commit.sha)) reachedBoth.push(commit);
      carried |= STALE;
    }
    const parents = await Promise.all(
      commit.parents.map(async (sha) => commits.get(sha) ?? source.commit(sha)),
    );
    for (const parent of parents) if (parent !== null) paint(parent, carried);
  }
  return { stopped: stopped(), candidates: reachedBoth.filter((commit) => !isStale(commit)) };
}

/**
 * True when `ancestor` is reachable from `descendant` (a commit contains itself), as the
 * reference's `contains` answers it; false when either commit is missing. Reads only the history
 * between the two commits and their merge base, whichever way the answer goes.
 */
export async function isAncestor(
  source: CommitSource,
  descendant: string,
  ancestor: string,
): Promise<boolean> {
  const [below, above] = await Promise.all([source.commit(ancestor), source.commit(descendant)]);
  if (below === null || above === null) return false;
  if (below.sha === above.sha) return true;
  return (await paintDown(source, below, above, below.sha)).stopped;
}

/**
 * Every best common ancestor of two commits — a common ancestor no other common ancestor descends
 * from — ranked as the reference's `mergeBase` ranks them: newest committer date first, then the
 * lowest id. Empty when the histories are unrelated or either commit is missing.
 */
export async function bestCommonAncestors(source: CommitSource, a: string, b: string): Promise<Commit[]> {
  const [first, second] = await Promise.all([source.commit(a), source.commit(b)]);
  if (first === null || second === null) return [];
  const { candidates } = await paintDown(source, first, second, null);
  const best: Commit[] = [];
  for (const candidate of candidates) {
    let beneathAnother = false;
    for (const other of candidates) {
      if (other.sha === candidate.sha) continue;
      if (await isAncestor(source, other.sha, candidate.sha)) {
        beneathAnother = true;
        break;
      }
    }
    if (!beneathAnother) best.push(candidate);
  }
  return best.toSorted((x, y) => dateOrder(y, x) || (x.sha < y.sha ? -1 : 1));
}

/** The best common ancestor of two commits as the reference's `mergeBase` picks it, or null. */
export async function mergeBaseOf(source: CommitSource, a: string, b: string): Promise<string | null> {
  return (await bestCommonAncestors(source, a, b))[0]?.sha ?? null;
}
