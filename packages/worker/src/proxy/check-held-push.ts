// SPDX-License-Identifier: Apache-2.0
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';

import { provePending } from '../policy/branch-policy.ts';
import { judgeChangedPaths } from '../push-policy/run-push-policy.ts';
import type { GatewayDeps } from './gateway-deps.ts';
import type { AllowedPush } from './gateway-env.ts';
import type { RefRefusal } from './git-responses.ts';
import type { GitRequest } from './git-route.ts';
import { holdPush, type OverflowingPush } from './push-guard.ts';

/** The reason given for every update when proving the push failed unexpectedly. */
const UNCHECKED_REASON = 'the push could not be checked; try again later';

/**
 * The verdict on a held push: its bytes to forward, the refused updates (and nothing to forward),
 * or a push with only fast-forwards to prove whose pack is too large to hold, to be streamed and
 * proven from the pack alone.
 */
export type HeldPushVerdict =
  | { readonly kind: 'allowed'; readonly body: Uint8Array }
  | { readonly kind: 'refused'; readonly refusals: readonly RefRefusal[] }
  | OverflowingPush;

/** Who pushes where, for {@link checkHeldPush}. */
export interface HeldPushContext {
  readonly requestId: string;
  readonly principal: Principal;
  readonly git: GitRequest;
}

/**
 * How much pack to hold, and what a larger one gets: a push the push policy still checks needs its
 * whole pack and is refused past `maxPushPolicyPackBytes`; one with only fast-forwards to prove
 * is streamed past `maxFastForwardPackBytes`.
 */
function packBound(deps: GatewayDeps, push: AllowedPush) {
  const policy = deps.config.maxPushPolicyPackBytes;
  if (push.policyUpdates !== null)
    return {
      maxPackBytes: policy,
      overflow: {
        refuse: `the push policy could not check this push: the pack is larger than ${policy} bytes`,
      },
    };
  return { maxPackBytes: deps.config.maxFastForwardPackBytes, overflow: 'stream' as const };
}

/**
 * Reads a push whole, then proves its pending fast-forwards and runs the push policy over its
 * changed paths — every storage read made here, before any request to the storage host is open,
 * so a host that locks a repository for the whole of a receive-pack cannot block them. A push
 * that is unreadable, too large for the push policy, or whose proof fails unexpectedly, has every
 * update refused; one with only fast-forwards to prove that is too large to hold overflows.
 */
export async function checkHeldPush(
  deps: GatewayDeps,
  push: AllowedPush,
  context: HeldPushContext,
): Promise<HeldPushVerdict> {
  const { requestId, principal, git } = context;
  const refuseEvery = (reason: string): HeldPushVerdict => ({
    kind: 'refused',
    refusals: push.request.commands.map((command) => ({ ref: command.ref, reason })),
  });
  if (push.pending.length > 0) {
    deps.logger.log({
      level: 'debug',
      message: 'proving fast-forwards from the pushed pack',
      requestId,
      repo: git.repo,
      refs: push.pending.map(({ update }) => update.ref),
    });
  }
  const held = await holdPush(push.body, {
    headLength: push.headLength,
    maxCommitBytes: deps.config.maxScannedCommitBytes,
    ...packBound(deps, push),
  });
  if (held.kind === 'unheld') return refuseEvery(held.reason);
  if (held.kind === 'overflow') return held;
  const { policyUpdates } = push;
  const { pushPolicy } = deps;
  let refusals: readonly RefRefusal[];
  try {
    refusals = await provePending(deps, git, push.pending, held.scan.commits);
    if (refusals.length === 0 && policyUpdates !== null && pushPolicy !== undefined) {
      refusals = await judgeChangedPaths(
        { pushPolicy, backend: deps.backend, config: deps.config },
        { principal, repo: git.repo, updates: policyUpdates },
        held.pack,
      );
    }
  } catch (error) {
    deps.logger.log({
      level: 'error',
      message: 'proving the push failed',
      requestId,
      repo: git.repo,
      error: error instanceof Error ? error.message : String(error),
    });
    return refuseEvery(UNCHECKED_REASON);
  }
  return refusals.length === 0 ? { kind: 'allowed', body: held.body } : { kind: 'refused', refusals };
}
