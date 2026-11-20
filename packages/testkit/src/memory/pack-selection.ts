// SPDX-License-Identifier: Apache-2.0
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';

import type { MemoryRepository } from './memory-repository.ts';

/** What an upload-pack request asks to have sent. */
export interface PackSelection {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  /** Commits the client says it has without their parents (its "shallow" lines). */
  readonly clientShallow?: readonly string[];
  /** "deepen <n>": commits at most this many generations from each wanted commit. */
  readonly depth?: number;
  /** A partial-clone filter: "blob:none", "blob:limit=<n>[kmg]" or "tree:<depth>". */
  readonly filter?: string;
}

/** The objects to send and the shallow boundary to report. */
export interface SelectedPack {
  readonly objects: GitObject[];
  /** Commits the client must now treat as having no parents (the new deepen boundary). */
  readonly shallow: string[];
  /** Commits of the client's old boundary whose parents are now sent. */
  readonly unshallow: string[];
}

const UNITS: Readonly<Record<string, number>> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/**
 * Whether an object `depth` levels below a root tree passes the filter. Explicit wants always pass.
 * As in git's list-objects-filter.c, blob:limit=<n> keeps only blobs strictly smaller than n bytes.
 */
function passesFilter(filter: string | undefined, object: GitObject, depth: number): boolean {
  if (filter === undefined) return true;
  if (filter === 'blob:none') return object.type !== 'blob';
  const limit = /^blob:limit=(\d+)([kmg]?)$/.exec(filter);
  if (limit !== null)
    return object.type !== 'blob' || object.data.length < Number(limit[1]) * (UNITS[limit[2] ?? ''] ?? 1);
  const tree = /^tree:(\d+)$/.exec(filter);
  return tree === null || depth < Number(tree[1]);
}

/**
 * Walks commits from the wants: within `depth` generations when deepening (through commits the
 * client already has, which are not sent), otherwise until reaching what the client has. Returns
 * the commits to send and the boundary commits whose parents are cut off.
 */
function selectCommits(
  repo: MemoryRepository,
  wants: readonly string[],
  depth: number | undefined,
  excluded: ReadonlySet<string>,
): { commits: string[]; boundary: string[]; walked: Set<string> } {
  const commits: string[] = [];
  const boundary: string[] = [];
  const walked = new Set<string>();
  let frontier = wants.filter((sha) => repo.object(sha, 'commit') !== null);
  for (let generation = 1; frontier.length > 0; generation += 1) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (walked.has(sha) || (depth === undefined && excluded.has(sha))) continue;
      walked.add(sha);
      if (!excluded.has(sha)) commits.push(sha);
      const parents = repo.commit(sha)?.parents ?? [];
      if (depth !== undefined && generation >= depth) {
        if (parents.length > 0) boundary.push(sha);
      } else next.push(...parents);
    }
    frontier = next;
  }
  return { commits, boundary, walked };
}

/** Everything the client has: the closure of its haves, not crossing its shallow boundary. */
function clientHas(
  repo: MemoryRepository,
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = haves.filter((sha) => repo.objects.has(sha));
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (out.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    out.add(sha);
    const links = repo.links(object);
    stack.push(...(object.type === 'commit' && clientShallow.has(sha) ? links.slice(0, 1) : links));
  }
  return out;
}

/**
 * Chooses the objects an upload-pack answer carries: everything reachable from the wants and not
 * from the haves (whose history stops at the client's shallow commits), cut at `depth`
 * generations of commits when deepening, and with the filter
 * applied to trees and blobs (depth counted from each root tree, a wanted tree being a root).
 * Explicitly wanted objects are always sent, as git sends them.
 */
export function selectPack(repo: MemoryRepository, selection: PackSelection): SelectedPack {
  const clientShallow = new Set(selection.clientShallow ?? []);
  const excluded = clientHas(repo, selection.haves, clientShallow);
  const { commits, boundary, walked } = selectCommits(repo, selection.wants, selection.depth, excluded);
  const shallow = boundary.filter((sha) => !clientShallow.has(sha));
  const unshallow = [...clientShallow].filter((sha) => walked.has(sha) && !boundary.includes(sha));
  const out = new Map<string, GitObject>();
  const visit = (sha: string, depth: number, explicit: boolean): void => {
    if (out.has(sha) || excluded.has(sha)) return;
    const object = repo.object(sha);
    if (object === null || object.type === 'commit') return;
    if (!explicit && !passesFilter(selection.filter, object, depth)) return;
    out.set(sha, object);
    if (object.type === 'tree')
      for (const entry of repo.tree(sha) ?? [])
        if (entry.mode !== '160000') visit(entry.sha, depth + 1, false);
  };
  for (const sha of commits) {
    const commit = repo.commit(sha);
    const object = repo.object(sha, 'commit');
    if (commit === null || object === null) continue;
    out.set(sha, object);
    visit(commit.tree, 0, false);
  }
  for (const want of selection.wants) visit(want, 0, true);
  return { objects: [...out.values()], shallow, unshallow };
}
