// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput, RpcParsedInput } from '@leed-ai/git-gateway-contract/git-gateway';
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { mergeTrees } from '@leed-ai/git-gateway-core/merge/merge-trees';
import { createCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';

import { CommitGraph } from './commit-graph.ts';
import type { GatewayContext } from './gateway-context.ts';
import { pushRefUpdate } from './push-ref.ts';
import { branchHead, branchRef, requireBranchHead, requireCommit, treeReader } from './repo-access.ts';

/** syncBranch() input after parsing. */
export type SyncParams = RpcParsedInput<'syncBranch'>;

/** The outcome of one sync attempt. */
export type SyncAttempt =
  | { readonly kind: 'done'; readonly output: RpcOutput<'syncBranch'> }
  /** The push was refused because `into` moved; `intoHead` is the head that was built on. */
  | { readonly kind: 'stale'; readonly intoHead: string };

/** A commit message as git stores it: ending in exactly one newline. */
const asStoredMessage = (message: string): string => {
  // A scan from the end, not /\n+$/: that regex retries from every newline run (polynomial time).
  let end = message.length;
  while (end > 0 && message.charCodeAt(end - 1) === 10) end -= 1;
  return `${message.slice(0, end)}\n`;
};

/**
 * One attempt at syncBranch(): `into` already contains `from` → up_to_date; `into` has nothing of
 * its own → fast-forward; otherwise a file-level three-way merge against the merge base (the
 * reference's own merge-base rule, found by a paint-down walk that reads only the history since it), written as a merge commit whose
 * parents are `into` then `from`, or a conflict listing every path, with nothing written. Every
 * push names the head of `into` it was built on, so nothing is overwritten or forced.
 */
export async function attemptSync(context: GatewayContext, input: SyncParams): Promise<SyncAttempt> {
  const { repo, from, into } = input;
  const fromHead = await requireBranchHead(context, repo, from);
  const intoHead = await requireBranchHead(context, repo, into);
  // One paint-down walk answers all three questions: `from` is contained in `into` exactly when
  // it is their merge base, `into` in `from` exactly when `into` is.
  const base = await new CommitGraph(context, repo).mergeBase(intoHead, fromHead);
  if (base === fromHead) {
    return { kind: 'done', output: { status: 'up_to_date', head: intoHead } };
  }
  const refUpdate = (newSha: string) => ({ ref: branchRef(into), oldSha: intoHead, newSha });
  /** Pushes `into` to `newSha`; false when `into` moved first (a refusal for any other reason throws). */
  const push = async (newSha: string, objects: readonly GitObject[]): Promise<boolean> => {
    const pushed = await pushRefUpdate(context, repo, refUpdate(newSha), objects);
    if (pushed.status === 'ok') return true;
    if ((await branchHead(context, repo, into)) === intoHead) {
      throw storageUnavailable(`push to ${branchRef(into)}`, pushed.reason);
    }
    return false;
  };
  if (base === intoHead) {
    if (!(await push(fromHead, []))) return { kind: 'stale', intoHead };
    return { kind: 'done', output: { status: 'fast_forward', refUpdate: refUpdate(fromHead) } };
  }
  if (base === null) {
    throw gatewayError('unrelated_histories', `${from} and ${into} share no history`, { from, into });
  }
  const treeOf = async (sha: string): Promise<string> => (await requireCommit(context, repo, sha)).tree;
  const merged = await mergeTrees(
    { base: await treeOf(base), ours: await treeOf(intoHead), theirs: await treeOf(fromHead) },
    treeReader(context, repo),
  );
  if (merged.status === 'conflict') {
    return { kind: 'done', output: { status: 'conflict', paths: merged.paths, base, fromHead, intoHead } };
  }
  const identity = input.author ?? context.config.serviceIdentity;
  const signature = { ...identity, date: context.now().toISOString() };
  const { object, commit } = await createCommit({
    tree: merged.tree,
    parents: [intoHead, fromHead],
    author: signature,
    committer: signature,
    message: asStoredMessage(input.message ?? `Merge branch '${from}' into ${into}`),
  });
  if (!(await push(commit.sha, [...merged.objects, object]))) return { kind: 'stale', intoHead };
  return { kind: 'done', output: { status: 'merged', commit, refUpdate: refUpdate(commit.sha) } };
}
