// SPDX-License-Identifier: Apache-2.0
import { PolicyResult, type RefDecision } from '@leed-ai/git-gateway-contract/proxy/policy-result';
import { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';

import type { GatewayDeps } from '../proxy/gateway-deps.ts';
import type { PendingFastForward } from '../proxy/gateway-env.ts';
import type { RefRefusal } from '../proxy/git-responses.ts';
import type { GitRequest } from '../proxy/git-route.ts';
import { proveFastForward } from './fast-forward.ts';

/** The branch policy's verdict on a push before its pack is read. */
export interface PushVerdict {
  /** Updates refused outright; when any is, nothing is forwarded. */
  readonly refusals: readonly RefRefusal[];
  /** Fast-forward-only updates whose new commit is not in storage yet: proven from the pack. */
  readonly pending: readonly PendingFastForward[];
}

/** One line of at most 500 characters, as a report-status reason must be. */
export function reasonLine(text: string): string {
  const line = text.replaceAll(/[\n\r\0]+/g, ' ').trim();
  return (line === '' ? 'refused' : line).slice(0, 500);
}

const NOT_A_BRANCH = 'only branches (refs/heads/*) and tags (refs/tags/*) can be pushed through this gateway';
const UNVERIFIABLE = 'could not verify that the update is a fast-forward';

/**
 * Runs the branch policy over every update of a push. Updates outside refs/heads/ and refs/tags/
 * are refused before the policy is asked. A "fast-forward-only" decision allows a creation and
 * refuses a deletion (no new commit can contain the old head); on an existing tag it is refused (moving a tag is never a fast-forward); on a branch whose new commit storage already
 * has, ancestry is proven now; otherwise it is left pending, to be proven from the pack.
 */
export async function judgePush(
  deps: GatewayDeps,
  git: GitRequest,
  principal: Parameters<GatewayDeps['branchPolicy']['check']>[0],
  request: ReceivePackRequest,
): Promise<PushVerdict> {
  const refusals: RefRefusal[] = [];
  const updates: RefUpdate[] = [];
  for (const command of request.commands) {
    const parsed = RefUpdate.safeParse(command);
    if (parsed.success) updates.push(parsed.data);
    else refusals.push({ ref: command.ref, reason: NOT_A_BRANCH });
  }
  const result =
    updates.length === 0
      ? { refs: [] }
      : PolicyResult.parse(deps.branchPolicy.check(principal, git.repo, updates));
  const decisions = new Map<string, RefDecision>(result.refs.map((decision) => [decision.ref, decision]));
  const pending: PendingFastForward[] = [];
  for (const update of updates) {
    const decision = decisions.get(update.ref);
    if (decision === undefined) {
      refusals.push({ ref: update.ref, reason: 'the branch policy made no decision for this ref' });
      continue;
    }
    if (decision.decision === 'allow') continue;
    const reason = reasonLine(decision.reason);
    if (decision.decision === 'deny') {
      refusals.push({ ref: update.ref, reason });
      continue;
    }
    if (update.newSha === ZERO_SHA) {
      refusals.push({ ref: update.ref, reason });
      continue;
    }
    if (update.oldSha === ZERO_SHA) continue;
    if (update.ref.startsWith('refs/tags/')) {
      refusals.push({ ref: update.ref, reason });
      continue;
    }
    let stored: boolean;
    try {
      stored = (await deps.backend.readCommit(git.repo, update.newSha)) !== null;
    } catch {
      refusals.push({ ref: update.ref, reason: reasonLine(`${reason} (${UNVERIFIABLE})`) });
      continue;
    }
    if (!stored) {
      pending.push({ update, reason });
      continue;
    }
    const verdict = await proveFastForward(update.oldSha, update.newSha, {
      repo: git.repo,
      backend: deps.backend,
      maxReads: deps.config.maxAncestryReads,
    });
    if (verdict === 'no') refusals.push({ ref: update.ref, reason });
    if (verdict === 'unknown')
      refusals.push({ ref: update.ref, reason: reasonLine(`${reason} (${UNVERIFIABLE})`) });
  }
  return { refusals, pending };
}

/** Proves pending fast-forwards from the scanned pack and storage; returns those that are not. */
export async function provePending(
  deps: GatewayDeps,
  git: GitRequest,
  pending: readonly PendingFastForward[],
  packCommits: ReadonlyMap<string, readonly string[]>,
): Promise<RefRefusal[]> {
  const refusals: RefRefusal[] = [];
  for (const { update, reason } of pending) {
    const verdict = await proveFastForward(update.oldSha, update.newSha, {
      repo: git.repo,
      backend: deps.backend,
      packCommits,
      maxReads: deps.config.maxAncestryReads,
    });
    if (verdict === 'no') refusals.push({ ref: update.ref, reason });
    if (verdict === 'unknown')
      refusals.push({ ref: update.ref, reason: reasonLine(`${reason} (${UNVERIFIABLE})`) });
  }
  return refusals;
}
