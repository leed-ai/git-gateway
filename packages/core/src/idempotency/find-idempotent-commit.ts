// SPDX-License-Identifier: Apache-2.0
import { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import { coreError } from '../core-error.ts';
import { IdempotencyLookupInput } from '../schemas/idempotency-lookup.ts';

/** Reads commits by id, the way `StorageBackend.readCommit` does. */
export interface CommitReader {
  /** The commit with this id, or null when the repository has no such commit. */
  readCommit(sha: string): Promise<Commit | null>;
}

async function load(reader: CommitReader, sha: string): Promise<Commit | null> {
  const found = await reader.readCommit(sha);
  if (found === null) return null;
  const parsed = Commit.safeParse(found);
  if (!parsed.success) {
    throw coreError('invalid_object', `Invalid commit: ${sha}`, {
      sha,
      type: 'commit',
      reason: parsed.error.issues[0]?.message ?? 'invalid commit',
    });
  }
  return parsed.data;
}

/** The index of the newest commit by committer date; on a tie, the one discovered last. */
function newestIndex(queue: readonly Commit[]): number {
  let best = -1;
  queue.forEach((commit, index) => {
    const current = queue[best];
    if (current === undefined || Date.parse(commit.committer.date) >= Date.parse(current.committer.date)) {
      best = index;
    }
  });
  return best;
}

/**
 * Searches a branch's recent history for the commit whose message carries the
 * "Gateway-Idempotency-Key:" trailer with `key`, so a retried write returns that commit instead of
 * committing twice. Commits are visited newest committer date first, starting at `head` and
 * following every parent, until `window.maxCommits` commits have been examined or a commit
 * committed more than `window.maxAgeSeconds` before `now` is reached. Parents the reader does not
 * have (a shallow history) are skipped. Returns null when no commit in the window has the key, and
 * throws a missing_object CoreError when `head` itself cannot be read.
 */
export async function findIdempotentCommit(
  input: IdempotencyLookupInput,
  reader: CommitReader,
): Promise<Commit | null> {
  const { head, key, window, now } = IdempotencyLookupInput.parse(input);
  const oldest = Date.parse(now) - window.maxAgeSeconds * 1000;
  const first = await load(reader, head);
  if (first === null)
    throw coreError('missing_object', `Commit not found: ${head}`, { sha: head, type: 'commit' });
  const queue: Commit[] = [first];
  const seen = new Set([head]);
  for (let examined = 0; examined < window.maxCommits && queue.length > 0; examined += 1) {
    const [commit] = queue.splice(newestIndex(queue), 1);
    if (commit === undefined || Date.parse(commit.committer.date) < oldest) return null;
    if (commit.idempotencyKey === key) return commit;
    for (const parent of commit.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const loaded = await load(reader, parent);
      if (loaded !== null) queue.push(loaded);
    }
  }
  return null;
}
