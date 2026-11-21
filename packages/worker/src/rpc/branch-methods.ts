// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput } from '@leed-ai/git-gateway-contract/git-gateway';
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';

import type { GatewayContext } from './gateway-context.ts';
import { attemptPromote, type PromoteParams } from './promote-attempt.ts';
import { branchHead } from './repo-access.ts';
import { attemptSync, type SyncParams } from './sync-attempt.ts';

/** The stale_head error for a branch that kept moving through every inline attempt. */
async function stillMoving(
  context: GatewayContext,
  repo: string,
  branch: string,
  expectedHead: string | null,
): Promise<Error> {
  return gatewayError('stale_head', `Branch ${branch} kept moving; retry`, {
    branch,
    expectedHead,
    actualHead: await branchHead(context, repo, branch),
  });
}

/**
 * syncBranch(): up to `1 + config.inlineRetries` attempts, each re-reading both heads. When
 * `into` moved under every attempt, stale_head (retryable by the caller, or by a
 * SyncBranchWorkflow).
 */
export async function gatewaySyncBranch(
  context: GatewayContext,
  input: SyncParams,
): Promise<RpcOutput<'syncBranch'>> {
  let lastHead: string | null = null;
  for (let attempt = 0; attempt <= context.config.inlineRetries; attempt += 1) {
    const outcome = await attemptSync(context, input);
    if (outcome.kind === 'done') return outcome.output;
    lastHead = outcome.intoHead;
  }
  throw await stillMoving(context, input.repo, input.into, lastHead);
}

/**
 * promote(): up to `1 + config.inlineRetries` attempts, each re-checking both refusals against
 * the current heads. When `into` moved under every attempt, stale_head.
 */
export async function gatewayPromote(
  context: GatewayContext,
  input: PromoteParams,
): Promise<RpcOutput<'promote'>> {
  let lastHead: string | null = null;
  for (let attempt = 0; attempt <= context.config.inlineRetries; attempt += 1) {
    const outcome = await attemptPromote(context, input);
    if (outcome.kind === 'done') return outcome.output;
    lastHead = outcome.intoHead;
  }
  throw await stillMoving(context, input.repo, input.into, lastHead);
}
