// SPDX-License-Identifier: Apache-2.0
import { invalidInput } from '@leed-ai/git-gateway-contract/gateway-error';
import type { SyncRule } from '@leed-ai/git-gateway-contract/schemas/gateway-config';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { PushEvent } from './push-event.ts';
import type { SyncBranchWorkflowParams } from './sync-workflow-schemas.ts';
import { syncWorkflowId } from './workflow-instance-id.ts';
import { startWorkflowOnce, type WorkflowStarter } from './workflow-starter.ts';

/** Something a deployment runs after every accepted push. Rejecting asks for the event again. */
export type OnPushHook = (event: PushEvent) => Promise<void>;

/**
 * The onPush hook for the configured sync rules: for every rule whose `from` branch the push
 * moved (not deleted), start a SyncBranchWorkflow syncing `into` from it. The instance id is
 * derived from repository, both branches and the new head, so a redelivered event starts nothing
 * new.
 */
export function syncRuleHook(
  syncRules: readonly SyncRule[],
  syncWorkflow: WorkflowStarter<SyncBranchWorkflowParams>,
): OnPushHook {
  return async (event) => {
    for (const rule of syncRules) {
      const update = event.updates.findLast(
        (candidate) => candidate.ref === `refs/heads/${rule.from}` && candidate.newSha !== ZERO_SHA,
      );
      if (update === undefined) continue;
      const params = { repo: event.repo, from: rule.from, into: rule.into, fromHead: update.newSha };
      const id = await syncWorkflowId(event.repo, rule.from, rule.into, update.newSha);
      await startWorkflowOnce(syncWorkflow, id, params);
    }
  };
}

/**
 * Delivers one push event to every hook. The event is parsed with {@link PushEvent} first
 * (invalid_input when it does not match). Every hook runs even when another fails; if any failed,
 * an AggregateError of their errors is thrown afterwards. Hooks must therefore be idempotent, as
 * {@link syncRuleHook} is.
 */
export async function dispatchPushEvent(event: unknown, hooks: readonly OnPushHook[]): Promise<void> {
  const parsed = PushEvent.safeParse(event);
  if (!parsed.success) throw invalidInput(parsed.error);
  const results = await Promise.allSettled(hooks.map((hook) => hook(parsed.data)));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} onPush hook(s) failed`);
}

/** The part of a Queues message the consumer uses. */
export interface PushEventMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

/** What {@link consumePushEvents} did with a batch. */
export interface PushBatchOutcome {
  /** Events every hook handled. */
  readonly delivered: number;
  /** Messages that are not push events; acknowledged, since redelivery cannot fix them. */
  readonly dropped: number;
  /** Events some hook failed on; handed back to the queue for redelivery. */
  readonly retried: number;
}

/**
 * A Queues consumer for push events: each message is dispatched to the hooks, then acknowledged,
 * or retried when a hook failed. Messages that do not parse as a {@link PushEvent} are
 * acknowledged and counted as dropped.
 */
export async function consumePushEvents(
  batch: { readonly messages: readonly PushEventMessage[] },
  hooks: readonly OnPushHook[],
): Promise<PushBatchOutcome> {
  let delivered = 0;
  let dropped = 0;
  let retried = 0;
  for (const message of batch.messages) {
    if (!PushEvent.safeParse(message.body).success) {
      message.ack();
      dropped += 1;
      continue;
    }
    try {
      await dispatchPushEvent(message.body, hooks);
      message.ack();
      delivered += 1;
    } catch {
      message.retry();
      retried += 1;
    }
  }
  return { delivered, dropped, retried };
}
