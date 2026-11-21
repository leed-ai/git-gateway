// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput } from '@leed-ai/git-gateway-contract/git-gateway';
import { invalidInput } from '@leed-ai/git-gateway-contract/gateway-error';

import type { GatewayContext } from '../rpc/gateway-context.ts';
import { attemptSync } from '../rpc/sync-attempt.ts';
import { BranchMovedError, classifyStepError } from './step-errors.ts';
import { keepError, type FatalError, type StepConfig, type StepRunner } from './step-runner.ts';
import { SyncBranchWorkflowParams, SyncStepResult } from './sync-workflow-schemas.ts';

/** Retries of the sync step: back off from 5 s, eight times. */
export const SYNC_STEP_CONFIG: StepConfig = {
  retries: { limit: 8, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

/** The stored form of a syncBranch() result: ids and paths only. */
function summarize(output: RpcOutput<'syncBranch'>): SyncStepResult {
  if (output.status === 'up_to_date') return { status: 'up_to_date', head: output.head };
  if (output.status === 'fast_forward') return { status: 'fast_forward', head: output.refUpdate.newSha };
  if (output.status === 'merged') return { status: 'merged', head: output.commit.sha };
  const { paths, base, fromHead, intoHead } = output;
  return { status: 'conflict', paths, base, fromHead, intoHead };
}

/**
 * The body of SyncBranchWorkflow: one durable step that syncs `into` with `from` (see
 * syncBranch). `into` moving under the step throws so the engine retries with backoff; a missing
 * branch or unrelated histories stop the instance; a conflict completes it with the conflicting
 * paths. Replaying a step that merged and then crashed finds `into` already containing `from` and
 * reports up_to_date, so a sync never writes two merge commits.
 */
export async function runSyncWorkflow(
  context: GatewayContext,
  payload: unknown,
  step: StepRunner,
  fatal: FatalError = keepError,
): Promise<SyncStepResult> {
  const parsed = SyncBranchWorkflowParams.safeParse(payload);
  if (!parsed.success) throw fatal(invalidInput(parsed.error));
  const { repo, from, into } = parsed.data;
  const stored = await step.do('sync', SYNC_STEP_CONFIG, async (): Promise<SyncStepResult> => {
    try {
      const outcome = await attemptSync(context, { repo, from, into });
      if (outcome.kind === 'stale') throw new BranchMovedError(into);
      return SyncStepResult.parse(summarize(outcome.output));
    } catch (thrown) {
      throw classifyStepError(thrown, fatal);
    }
  });
  return SyncStepResult.parse(stored);
}
