// SPDX-License-Identifier: Apache-2.0
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';

/** Whether an update is a fast-forward: "yes", "no", or "unknown" when it cannot be shown either way. */
export type FastForwardVerdict = 'yes' | 'no' | 'unknown';

/** Where the ancestry walk finds commits. */
export interface AncestrySources {
  /** The repository the push targets. */
  readonly repo: string;
  readonly backend: Pick<StorageBackend, 'readCommit' | 'isAncestor'>;
  /** Commits in the pushed pack (not yet in storage), by id, with their parents. */
  readonly packCommits?: ReadonlyMap<string, readonly string[]>;
  /**
   * Most calls made to the backend before giving up with "unknown": commits read by the walk, or
   * `isAncestor` questions when the backend answers them.
   */
  readonly maxReads: number;
}

/**
 * Decides whether moving a ref from `oldSha` to `newSha` is a fast-forward — whether `oldSha` is
 * `newSha` or one of its ancestors.
 *
 * When the backend offers `isAncestor`, the commits of the pushed pack are walked from `newSha`
 * and the backend is asked once for each commit the walk leaves the pack at (the commits storage
 * already has): "yes" when `oldSha` is one of the pack commits or an ancestor of any of those,
 * "no" when it is neither. Otherwise parents are walked breadth-first from `newSha`, taking each
 * commit from the pushed pack when it is there and from the backend otherwise, until `oldSha` is
 * found ("yes") or the history is exhausted ("no").
 *
 * A commit found in neither place, a backend failure, or more than `maxReads` backend calls gives
 * "unknown": the caller cannot prove the update safe and must treat it as a force push.
 */
export async function proveFastForward(
  oldSha: string,
  newSha: string,
  sources: AncestrySources,
): Promise<FastForwardVerdict> {
  if (oldSha === newSha) return 'yes';
  const { backend, repo } = sources;
  if (backend.isAncestor === undefined) return walkHistory(oldSha, newSha, sources);
  return askBackend(
    oldSha,
    newSha,
    sources,
    async (ancestor, descendant) => backend.isAncestor?.(repo, ancestor, descendant) ?? null,
  );
}

/** Walks the pack's commits from `newSha`; returns "yes" on meeting `oldSha`, else where the walk left the pack. */
function walkPack(
  oldSha: string,
  newSha: string,
  packCommits: ReadonlyMap<string, readonly string[]> | undefined,
): 'yes' | string[] {
  const seen = new Set<string>([newSha]);
  const stored: string[] = [];
  let frontier = [newSha];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      const parents = packCommits?.get(sha);
      if (parents === undefined) {
        stored.push(sha);
        continue;
      }
      for (const parent of parents) {
        if (parent === oldSha) return 'yes';
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return stored;
}

async function askBackend(
  oldSha: string,
  newSha: string,
  sources: AncestrySources,
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean | null>,
): Promise<FastForwardVerdict> {
  const stored = walkPack(oldSha, newSha, sources.packCommits);
  if (stored === 'yes') return 'yes';
  if (stored.length > sources.maxReads) return 'unknown';
  for (const sha of stored) {
    let answer: boolean | null;
    try {
      answer = await isAncestor(oldSha, sha);
    } catch {
      return 'unknown';
    }
    if (answer === null) return 'unknown';
    if (answer) return 'yes';
  }
  return 'no';
}

async function walkHistory(
  oldSha: string,
  newSha: string,
  sources: AncestrySources,
): Promise<FastForwardVerdict> {
  const seen = new Set<string>([newSha]);
  let frontier = [newSha];
  let reads = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      let parents = sources.packCommits?.get(sha);
      if (parents === undefined) {
        reads += 1;
        if (reads > sources.maxReads) return 'unknown';
        try {
          parents = (await sources.backend.readCommit(sources.repo, sha))?.parents;
        } catch {
          return 'unknown';
        }
        if (parents === undefined) return 'unknown';
      }
      for (const parent of parents) {
        if (parent === oldSha) return 'yes';
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return 'no';
}
