// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput, RpcParsedInput } from '@leed-ai/git-gateway-contract/git-gateway';
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { buildCommit } from '@leed-ai/git-gateway-core/commit/build-commit';
import { findIdempotentCommit } from '@leed-ai/git-gateway-core/idempotency/find-idempotent-commit';

import type { GatewayContext } from './gateway-context.ts';
import { pushRefUpdate } from './push-ref.ts';
import { branchHead, hasBranches, requireBranchHead, requireCommit, treeReader } from './repo-access.ts';

/** commit() input after parsing. */
export type CommitParams = RpcParsedInput<'commit'>;

/** The outcome of one commit attempt. */
export type CommitAttempt =
  /** Finished: committed, replayed or no-op. Never "queued"; handing off is the caller's choice. */
  | { readonly kind: 'done'; readonly output: Exclude<RpcOutput<'commit'>, { status: 'queued' }> }
  /** The push was refused because the branch moved; rebuild on `head` and try again. */
  | { readonly kind: 'stale'; readonly head: string | null };

/** The commit a missing branch starts from: the start branch's head, none (a root commit), or ref_not_found. */
async function startOf(context: GatewayContext, input: CommitParams): Promise<string | null> {
  if (input.startBranch !== undefined) return requireBranchHead(context, input.repo, input.startBranch);
  if (!(await hasBranches(context, input.repo))) return null;
  throw gatewayError('ref_not_found', `Branch not found: ${input.branch}`, { ref: input.branch });
}

/**
 * One attempt at commit(), in the contract's order: idempotency replay (a commit carrying the key
 * in the branch's recent history is returned as is), then the stale-head check against
 * `expectedHead`, then the actions — built without a clone on the current head and pushed with an
 * update naming that head. Safe to repeat any number of times, including after a crash between
 * the push and recording its result: the next attempt finds the pushed commit by its key.
 */
export async function attemptCommit(context: GatewayContext, input: CommitParams): Promise<CommitAttempt> {
  const { repo, branch } = input;
  const head = await branchHead(context, repo, branch);
  if (head !== null) {
    const replay = await findIdempotentCommit(
      {
        head,
        key: input.idempotencyKey,
        window: context.config.idempotency,
        now: context.now().toISOString(),
      },
      { readCommit: (sha) => context.backend.readCommit(repo, sha) },
    );
    if (replay !== null) return { kind: 'done', output: { status: 'replayed', commit: replay } };
  }
  if (input.expectedHead !== undefined && input.expectedHead !== head) {
    throw gatewayError('stale_head', `Branch ${branch} moved`, {
      branch,
      expectedHead: input.expectedHead,
      actualHead: head,
    });
  }
  const baseSha = head ?? (await startOf(context, input));
  const base =
    baseSha === null ? null : { sha: baseSha, tree: (await requireCommit(context, repo, baseSha)).tree };
  const built = await buildCommit(
    {
      branch,
      base,
      oldSha: head,
      actions: input.actions,
      message: input.message,
      author: input.author,
      ...(input.committer === undefined ? {} : { committer: input.committer }),
      idempotencyKey: input.idempotencyKey,
      date: context.now().toISOString(),
    },
    treeReader(context, repo),
  );
  if (built.status === 'noop') return { kind: 'done', output: { status: 'noop', head } };
  const pushed = await pushRefUpdate(context, repo, built.refUpdate, built.objects);
  if (pushed.status === 'ok') {
    return {
      kind: 'done',
      output: { status: 'committed', commit: built.commit, refUpdate: built.refUpdate },
    };
  }
  const current = await branchHead(context, repo, branch);
  // A refusal while the branch still names the head we built on is not contention: the host said no.
  if (current === head) throw storageUnavailable(`push to ${built.refUpdate.ref}`, pushed.reason);
  return { kind: 'stale', head: current };
}
