// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput, RpcParsedInput } from '@leed-ai/git-gateway-contract/git-gateway';
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';

import { CommitGraph } from './commit-graph.ts';
import type { GatewayContext } from './gateway-context.ts';
import { pushRefUpdate } from './push-ref.ts';
import { branchHead, branchRef, requireBranchHead } from './repo-access.ts';

/** promote() input after parsing. */
export type PromoteParams = RpcParsedInput<'promote'>;

/** The outcome of one promote attempt. */
export type PromoteAttempt =
  | { readonly kind: 'done'; readonly output: RpcOutput<'promote'> }
  /** `into` moved between the checks and the push; `intoHead` is what the push named. */
  | { readonly kind: 'stale'; readonly intoHead: string | null };

/**
 * One attempt at promote(): refuses unless `sha` is the head of `from` (not_head_of_source) and
 * contains the head of `into` (not_fast_forward); otherwise moves `into` to `sha` with an update
 * naming its current head (or creates it). Never merges, never forces.
 */
export async function attemptPromote(context: GatewayContext, input: PromoteParams): Promise<PromoteAttempt> {
  const { repo, from, into, sha } = input;
  const fromHead = await requireBranchHead(context, repo, from);
  if (fromHead !== sha) {
    throw gatewayError('not_head_of_source', `${sha} is not the head of ${from}`, {
      from,
      sha,
      head: fromHead,
    });
  }
  const intoHead = await branchHead(context, repo, into);
  if (intoHead === sha) return { kind: 'done', output: { status: 'up_to_date', head: sha } };
  if (intoHead !== null && !(await new CommitGraph(context, repo).contains(sha, intoHead))) {
    throw gatewayError('not_fast_forward', `${sha} does not contain the head of ${into}`, {
      into,
      sha,
      head: intoHead,
    });
  }
  const refUpdate = { ref: branchRef(into), oldSha: intoHead ?? ZERO_SHA, newSha: sha };
  const pushed = await pushRefUpdate(context, repo, refUpdate, []);
  if (pushed.status === 'ok') return { kind: 'done', output: { status: 'promoted', refUpdate } };
  if ((await branchHead(context, repo, into)) === intoHead) {
    throw storageUnavailable(`push to ${refUpdate.ref}`, pushed.reason);
  }
  return { kind: 'stale', intoHead };
}
