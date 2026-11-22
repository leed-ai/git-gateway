// SPDX-License-Identifier: Apache-2.0
import type { PushPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { PushedCommit } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import { PushPolicyNeeds, PushPolicyResult } from '@leed-ai/git-gateway-contract/proxy/push-policy-result';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import type { SmartHttpConfig } from '@leed-ai/git-gateway-contract/proxy/smart-http-config';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';

import { reasonLine } from '../policy/branch-policy.ts';
import type { RefRefusal } from '../proxy/git-responses.ts';
import { ChangedPaths } from './changed-paths.ts';
import { readPushedObjects } from './pushed-objects.ts';
import { ReadBudget, Uncheckable } from './uncheckable.ts';

/** What running the push policy needs from the gateway. */
export interface PushPolicyDeps {
  readonly pushPolicy: PushPolicy;
  readonly backend: StorageBackend;
  readonly config: SmartHttpConfig;
}

/** Who pushes what, where. */
export interface PushPolicyPush {
  readonly principal: Principal;
  readonly repo: string;
  readonly updates: readonly RefUpdate[];
}

/** Asks the policy whether it needs changed paths for a push. */
export async function pushPolicyNeeds(deps: PushPolicyDeps, push: PushPolicyPush): Promise<PushPolicyNeeds> {
  return PushPolicyNeeds.parse(await deps.pushPolicy.needs(push.principal, push.repo, push.updates));
}

/**
 * Runs the policy's check over a push with, per update, its commits (null when changed paths
 * were not asked for) and returns the refused updates: denied ones with the policy's reason, and
 * any the result does not name.
 */
export async function judgeWithPushPolicy(
  deps: PushPolicyDeps,
  push: PushPolicyPush,
  commits: readonly (PushedCommit[] | null)[],
): Promise<RefRefusal[]> {
  const result = PushPolicyResult.parse(
    await deps.pushPolicy.check({
      principal: push.principal,
      repo: push.repo,
      updates: push.updates.map((update, index) => ({ ...update, commits: commits[index] ?? null })),
    }),
  );
  const decisions = new Map(result.refs.map((decision) => [decision.ref, decision]));
  const refusals: RefRefusal[] = [];
  for (const update of push.updates) {
    const decision = decisions.get(update.ref);
    if (decision === undefined)
      refusals.push({ ref: update.ref, reason: 'the push policy made no decision for this ref' });
    else if (decision.decision === 'deny')
      refusals.push({ ref: update.ref, reason: reasonLine(decision.reason) });
  }
  return refusals;
}

/**
 * Computes every update's commits and changed paths from the whole pushed pack (`pack`, checksum
 * included) and storage, within the configured bounds, and runs the policy's check. A push that
 * cannot be checked within them has every update refused, saying why.
 */
export async function judgeChangedPaths(
  deps: PushPolicyDeps,
  push: PushPolicyPush,
  pack: Uint8Array,
): Promise<RefRefusal[]> {
  const { config, backend } = deps;
  let commits: PushedCommit[][];
  try {
    const budget = new ReadBudget(config.maxPushPolicyReads);
    const objects = await readPushedObjects(pack, {
      repo: push.repo,
      backend,
      budget,
      maxObjectBytes: config.maxPushPolicyObjectBytes,
    });
    const paths = new ChangedPaths({
      repo: push.repo,
      backend,
      objects,
      budget,
      maxChangedPaths: config.maxChangedPaths,
    });
    commits = [];
    for (const update of push.updates) commits.push(await paths.commitsOf(update));
  } catch (error) {
    if (!(error instanceof Uncheckable)) throw error;
    const reason = reasonLine(`the push policy could not check this push: ${error.message}`);
    return push.updates.map((update) => ({ ref: update.ref, reason }));
  }
  return judgeWithPushPolicy(deps, push, commits);
}
