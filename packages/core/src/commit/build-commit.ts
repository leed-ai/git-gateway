// SPDX-License-Identifier: Apache-2.0
import { appendIdempotencyTrailer } from '@leed-ai/git-gateway-contract/reference/trailer';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { applyCommitActions } from '../actions/apply-commit-actions.ts';
import { createCommit } from '../objects/commit-object.ts';
import { BuildCommitInput, type BuiltCommit } from '../schemas/build-commit.ts';
import type { TreeReader } from '../tree/tree-reader.ts';

/**
 * Builds a commit from actions without a clone: applies the actions to the base commit's tree
 * (reading only the directories they touch), then writes a commit whose parent is the base, with
 * the caller's author, committer and message and a "Gateway-Idempotency-Key:" trailer appended.
 *
 * Returns `noop` when the actions leave the tree unchanged; otherwise the commit, the objects to
 * pack (new blobs, new trees, then the commit) and the ref update naming the old head, so the
 * server refuses the push if the branch moved in the meantime. Rule failures throw a contract
 * GatewayError; nothing is written either way.
 */
export async function buildCommit(input: BuildCommitInput, reader: TreeReader): Promise<BuiltCommit> {
  const parsed = BuildCommitInput.parse(input);
  const { base } = parsed;
  const applied = await applyCommitActions({ tree: base?.tree ?? null, actions: parsed.actions }, reader);
  if (applied.status === 'noop') return { status: 'noop', head: base?.sha ?? null };
  const author = { ...parsed.author, date: parsed.date };
  const committer = { ...(parsed.committer ?? parsed.author), date: parsed.date };
  const { object, commit } = await createCommit({
    tree: applied.tree,
    parents: base === null ? [] : [base.sha],
    author,
    committer,
    message: appendIdempotencyTrailer(parsed.message, parsed.idempotencyKey),
  });
  const oldSha = (parsed.oldSha === undefined ? base?.sha : parsed.oldSha) ?? ZERO_SHA;
  return {
    status: 'ready',
    commit,
    refUpdate: { ref: `refs/heads/${parsed.branch}`, oldSha, newSha: commit.sha },
    objects: [...applied.objects, object],
  };
}
