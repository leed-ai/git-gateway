// SPDX-License-Identifier: Apache-2.0
import type { AuditRefOutcome } from '@leed-ai/git-gateway-contract/proxy/audit-event';
import { FullRefName } from '@leed-ai/git-gateway-contract/schemas/names';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';

import type { Logger } from '../logging/logger.ts';
import type { OnPushHook } from '../workflows/on-push.ts';
import type { PushEvent } from '../workflows/push-event.ts';

/** Most updates one push event carries (the PushEvent schema's cap); a larger push is split. */
export const MAX_EVENT_UPDATES = 1000;

/**
 * The push events for a smart-HTTP push, from the per-ref outcomes read from the storage host's
 * report-status: one event per {@link MAX_EVENT_UPDATES} updates the host reported "ok", in the
 * order the push named them. Refused and unknown updates are left out; no accepted update, no
 * event.
 */
export function pushEventsFrom(
  repo: string,
  outcomes: readonly AuditRefOutcome[],
  pushedAt: string,
): PushEvent[] {
  const updates: RefUpdate[] = outcomes
    .filter((outcome) => outcome.status === 'ok' && FullRefName.safeParse(outcome.ref).success)
    .map(({ ref, oldSha, newSha }) => ({ ref, oldSha, newSha }));
  const events: PushEvent[] = [];
  for (let start = 0; start < updates.length; start += MAX_EVENT_UPDATES) {
    events.push({ repo, updates: updates.slice(start, start + MAX_EVENT_UPDATES), pushedAt });
  }
  return events;
}

/** What {@link deliverPushEvents} needs from the gateway. */
export interface PushEventSink {
  readonly onPush: OnPushHook;
  readonly onPushError: (error: unknown) => void;
  readonly logger: Logger;
  readonly now: () => Date;
}

/**
 * Hands the accepted updates of a smart-HTTP push to the deployment's onPush hook, once the
 * storage host's report has been read. The push has already happened, so nothing here changes the
 * response: a hook failure is logged and passed to `onPushError`. When the report could not be
 * read (too large, malformed) no event is sent and a warning is logged. Never rejects.
 */
export async function deliverPushEvents(
  sink: PushEventSink,
  repo: string,
  outcomes: Promise<readonly AuditRefOutcome[]>,
  requestId: string,
): Promise<void> {
  let refs: readonly AuditRefOutcome[];
  try {
    refs = await outcomes;
  } catch (error) {
    report(sink, requestId, repo, error);
    return;
  }
  if (refs.some((ref) => ref.status === 'unknown')) {
    sink.logger.log({
      level: 'warn',
      message: 'push event incomplete: the storage host report could not be read for every ref',
      requestId,
      repo,
    });
  }
  for (const event of pushEventsFrom(repo, refs, sink.now().toISOString())) {
    try {
      await sink.onPush(event);
    } catch (error) {
      report(sink, requestId, repo, error);
    }
  }
}

function report(sink: PushEventSink, requestId: string, repo: string, error: unknown): void {
  sink.logger.log({
    level: 'error',
    message: 'onPush hook failed',
    requestId,
    repo,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    sink.onPushError(error);
  } catch {
    // The error handler failed too; the failure is already logged.
  }
}
