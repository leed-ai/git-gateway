// SPDX-License-Identifier: Apache-2.0
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';

/** Whether an update is a fast-forward: "yes", "no", or "unknown" when it cannot be shown either way. */
export type FastForwardVerdict = 'yes' | 'no' | 'unknown';

/** Where the ancestry walk finds commits. */
export interface AncestrySources {
  /** The repository the push targets. */
  readonly repo: string;
  readonly backend: Pick<StorageBackend, 'readCommit'>;
  /** Commits in the pushed pack (not yet in storage), by id, with their parents. */
  readonly packCommits?: ReadonlyMap<string, readonly string[]>;
  /** Most commits read from the backend before giving up with "unknown". */
  readonly maxReads: number;
}

/**
 * Decides whether moving a ref from `oldSha` to `newSha` is a fast-forward — whether `oldSha` is
 * `newSha` or one of its ancestors — by walking parents breadth-first from `newSha`, taking each
 * commit from the pushed pack when it is there and from the backend otherwise. Every commit
 * reachable is examined until `oldSha` is found ("yes") or the history is exhausted ("no"). A
 * commit found in neither place, a backend failure, or more than `maxReads` backend reads gives
 * "unknown": the caller cannot prove the update safe and must treat it as a force push.
 */
export async function proveFastForward(
  oldSha: string,
  newSha: string,
  sources: AncestrySources,
): Promise<FastForwardVerdict> {
  if (oldSha === newSha) return 'yes';
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
