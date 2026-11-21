// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '../schemas/commit.ts';

/** Looks up a stored commit by id. */
export type CommitLookup = (sha: string) => Commit | undefined;

/** Every commit reachable from `start`, itself included. */
export function ancestors(lookup: CommitLookup, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  for (let sha = stack.pop(); sha !== undefined; sha = stack.pop()) {
    if (seen.has(sha)) continue;
    const commit = lookup(sha);
    if (commit === undefined) continue;
    seen.add(sha);
    stack.push(...commit.parents);
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (a commit contains itself). */
export function contains(lookup: CommitLookup, descendant: string, ancestor: string): boolean {
  return ancestors(lookup, descendant).has(ancestor);
}

/**
 * History reachable from `start`, newest committer date first, never listing a commit before
 * one of its children; ties go to the commit discovered last (as git log does).
 */
export function walkHistory(lookup: CommitLookup, start: string): Commit[] {
  const reachable = ancestors(lookup, start);
  const pendingChildren = new Map<string, number>();
  for (const sha of reachable) {
    for (const parent of lookup(sha)?.parents ?? []) {
      pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
    }
  }
  const ordered: Commit[] = [];
  const ready: Commit[] = [];
  const first = lookup(start);
  if (first !== undefined) ready.push(first);
  while (ready.length > 0) {
    let pick = ready.length - 1;
    ready.forEach((candidate, index) => {
      const best = ready[pick];
      if (best !== undefined && candidate.committer.date > best.committer.date) pick = index;
    });
    const [commit] = ready.splice(pick, 1);
    if (commit === undefined) break;
    ordered.push(commit);
    for (const parent of commit.parents) {
      const left = (pendingChildren.get(parent) ?? 1) - 1;
      pendingChildren.set(parent, left);
      const parentCommit = lookup(parent);
      if (left === 0 && parentCommit !== undefined) ready.push(parentCommit);
    }
  }
  return ordered;
}

/**
 * The best common ancestor of two commits: a common ancestor no other common ancestor descends
 * from. When several qualify (criss-cross history) the newest by committer date wins, then the
 * lowest id. Null when the histories are unrelated.
 */
export function mergeBase(lookup: CommitLookup, a: string, b: string): string | null {
  const fromB = ancestors(lookup, b);
  const common = [...ancestors(lookup, a)].filter((sha) => fromB.has(sha));
  const best = common.filter(
    (candidate) => !common.some((other) => other !== candidate && contains(lookup, other, candidate)),
  );
  const ranked = best.toSorted((x, y) => {
    const dx = lookup(x)?.committer.date ?? '';
    const dy = lookup(y)?.committer.date ?? '';
    return dx === dy ? (x < y ? -1 : 1) : dx > dy ? -1 : 1;
  });
  return ranked[0] ?? null;
}
