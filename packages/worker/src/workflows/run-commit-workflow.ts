// SPDX-License-Identifier: Apache-2.0
import { invalidInput } from '@leed-ai/git-gateway-contract/gateway-error';

import { attemptCommit } from '../rpc/commit-attempt.ts';
import type { GatewayContext } from '../rpc/gateway-context.ts';
import { CommitStepResult, CommitWorkflowParams } from './commit-workflow-schemas.ts';
import { BranchMovedError, classifyStepError } from './step-errors.ts';
import { keepError, type FatalError, type StepConfig, type StepRunner } from './step-runner.ts';

/** Retries of the commit step: contention clears in seconds, so back off from 2 s, ten times. */
export const COMMIT_STEP_CONFIG: StepConfig = {
  retries: { limit: 10, delay: '2 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
};

/**
 * The body of CommitWorkflow: one durable step that makes one commit attempt with the
 * idempotency key the RPC call carried. A lost race throws so the engine retries the step with
 * backoff; a broken rule stops the instance. Because every attempt first looks for a commit
 * carrying the key, a step that pushed and then crashed before its result was stored finds its
 * own commit on replay and reports it as replayed: exactly one commit, however often the step
 * runs. The stored result holds ids only (see {@link CommitStepResult}).
 */
export async function runCommitWorkflow(
  context: GatewayContext,
  payload: unknown,
  step: StepRunner,
  fatal: FatalError = keepError,
): Promise<CommitStepResult> {
  const parsed = CommitWorkflowParams.safeParse(payload);
  if (!parsed.success) throw fatal(invalidInput(parsed.error));
  const params = parsed.data;
  const stored = await step.do('commit', COMMIT_STEP_CONFIG, async (): Promise<CommitStepResult> => {
    try {
      const outcome = await attemptCommit(context, params);
      if (outcome.kind === 'stale') throw new BranchMovedError(params.branch);
      const { output } = outcome;
      if (output.status === 'noop') return CommitStepResult.parse({ status: 'noop', head: output.head });
      return CommitStepResult.parse({ status: output.status, sha: output.commit.sha });
    } catch (thrown) {
      throw classifyStepError(thrown, fatal);
    }
  });
  return CommitStepResult.parse(stored);
}
