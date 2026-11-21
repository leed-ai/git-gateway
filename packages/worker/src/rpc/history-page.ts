// SPDX-License-Identifier: Apache-2.0
import { walkHistory } from '@leed-ai/git-gateway-contract/reference/history';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import { type CommitSource, dateOrder } from './commit-source.ts';

/** Which page of history to list. */
export interface HistoryPageRequest {
  readonly limit: number;
  readonly offset: number;
  /** ISO timestamp; commits committed before it are left out. */
  readonly since?: string | undefined;
}

/** One page of history and whether more follows it. */
export interface HistoryPage {
  readonly commits: Commit[];
  readonly hasMore: boolean;
}

/** Thrown inside the walk when a parent is dated after its child; the walk then reads everything. */
class DateSkew extends Error {}

/** Timestamps compared as strings can disagree with time by less than one second (fractions). */
const STRING_ORDER_SLACK_MS = 1000;

/** The reference's pick among ready commits: the newest committer date, with its tie rule. */
function referencePick(ready: readonly Commit[]): number {
  let pick = ready.length - 1;
  ready.forEach((candidate, index) => {
    const best = ready[pick];
    if (best !== undefined && candidate.committer.date > best.committer.date) pick = index;
  });
  return pick;
}

/** Applies `since`, then cuts the page. */
function cut(history: readonly Commit[], { limit, offset, since }: HistoryPageRequest): HistoryPage {
  const lowest = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  const kept = history.filter((commit) => Date.parse(commit.committer.date) >= lowest);
  return { commits: kept.slice(offset, offset + limit), hasMore: kept.length > offset + limit };
}

/** The whole reachable history in the reference's order, read in full (the fallback). */
async function fullHistory(source: CommitSource, start: Commit): Promise<Commit[]> {
  const commits = new Map<string, Commit>([[start.sha, start]]);
  let frontier = [start];
  while (frontier.length > 0) {
    const wanted = [...new Set(frontier.flatMap((commit) => commit.parents))].filter(
      (sha) => !commits.has(sha),
    );
    const read = await Promise.all(wanted.map((sha) => source.commit(sha)));
    frontier = read.filter((commit) => commit !== null);
    for (const commit of frontier) commits.set(commit.sha, commit);
  }
  return walkHistory((sha) => commits.get(sha), start.sha);
}

/**
 * The walk behind log(): emits the history reachable from `start` in exactly the reference's
 * order (`walkHistory`: newest committer date first, never a parent before its child, the
 * reference's tie rule), but reads only as far as the page needs.
 *
 * Commits are expanded (their parents read) newest committer date first. A ready commit — one
 * whose known children have all been emitted — is certain once every other unexpanded commit is
 * dated strictly before it: while committer dates never decrease from parent to child, an unseen
 * child of it would be dated at or after it, and could only be reached through such a commit. The
 * reference's pick is emitted only when it cannot be changed by a ready commit that is not
 * certain; otherwise the newest unexpanded commit is expanded first. The walk stops once
 * `offset + limit + 1` commits from `since` on have been emitted, or once everything left is older
 * than `since`.
 *
 * Every edge read is checked: on a parent dated after its child (clock skew) the walk gives up and
 * orders the whole reachable history instead, as the reference does. Skew lying entirely beyond
 * the commits the page needed is never read, and so cannot be detected; within it, the page can
 * differ from the reference's.
 */
export async function historyPage(
  source: CommitSource,
  start: Commit,
  request: HistoryPageRequest,
): Promise<HistoryPage> {
  try {
    return await boundedPage(source, start, request);
  } catch (error) {
    if (!(error instanceof DateSkew)) throw error;
    return cut(await fullHistory(source, start), request);
  }
}

async function boundedPage(
  source: CommitSource,
  start: Commit,
  request: HistoryPageRequest,
): Promise<HistoryPage> {
  const wanted = request.offset + request.limit + 1;
  const sinceMs = request.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.since);
  const commits = new Map<string, Commit>([[start.sha, start]]);
  const unexpanded = new Map<string, Commit>([[start.sha, start]]);
  const pendingChildren = new Map<string, number>();
  const ready: Commit[] = [start];
  const emitted: Commit[] = [];
  let kept = 0;

  const expand = async (commit: Commit): Promise<void> => {
    unexpanded.delete(commit.sha);
    const parents = await Promise.all(
      commit.parents.map(async (sha) => commits.get(sha) ?? source.commit(sha)),
    );
    commit.parents.forEach((sha, index) => {
      pendingChildren.set(sha, (pendingChildren.get(sha) ?? 0) + 1);
      const at = ready.findIndex((candidate) => candidate.sha === sha);
      if (at !== -1) ready.splice(at, 1);
      const parent = parents[index];
      if (parent === null || parent === undefined) return;
      if (dateOrder(parent, commit) > 0) throw new DateSkew();
      if (!commits.has(sha)) {
        commits.set(sha, parent);
        unexpanded.set(sha, parent);
      }
    });
  };
  const certain = (commit: Commit): boolean =>
    [...unexpanded.values()].every((other) => other.sha === commit.sha || dateOrder(other, commit) < 0);
  const nothingLeftSince = (): boolean =>
    ready.every((commit) => Date.parse(commit.committer.date) < sinceMs) &&
    [...unexpanded.values()].every(
      (commit) => Date.parse(commit.committer.date) < sinceMs - STRING_ORDER_SLACK_MS,
    );

  while (ready.length > 0 && kept < wanted && !nothingLeftSince()) {
    const pick = ready[referencePick(ready)];
    if (pick === undefined) break;
    if (unexpanded.has(pick.sha)) {
      await expand(pick);
      continue;
    }
    const newest = ready.filter((commit) => dateOrder(commit, pick) === 0);
    const last = ready.at(-1);
    const safe =
      newest.every(certain) &&
      (newest.length === 1 || last === undefined || dateOrder(last, pick) === 0 || certain(last));
    if (!safe) {
      let next: Commit | undefined;
      for (const commit of unexpanded.values())
        if (next === undefined || dateOrder(commit, next) > 0) next = commit;
      if (next !== undefined) {
        await expand(next);
        continue;
      }
    }
    ready.splice(ready.indexOf(pick), 1);
    emitted.push(pick);
    if (Date.parse(pick.committer.date) >= sinceMs) kept += 1;
    for (const sha of pick.parents) {
      const left = (pendingChildren.get(sha) ?? 1) - 1;
      pendingChildren.set(sha, left);
      const parent = commits.get(sha);
      if (left === 0 && parent !== undefined) ready.push(parent);
    }
  }
  return cut(emitted, request);
}
