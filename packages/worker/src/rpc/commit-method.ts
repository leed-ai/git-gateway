// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput } from '@leed-ai/git-gateway-contract/git-gateway';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';

import { commitWorkflowId } from '../workflows/workflow-instance-id.ts';
import { startWorkflowOnce } from '../workflows/workflow-starter.ts';
import { attemptCommit, type CommitParams } from './commit-attempt.ts';
import type { GatewayContext } from './gateway-context.ts';

/**
 * commit(): up to `1 + config.inlineRetries` attempts, each rebuilt on the head that beat the
 * previous one. When every attempt lost a race, the same input — idempotency key included — is
 * handed to a CommitWorkflow under an id derived from repository, branch and key (so handing the
 * same commit off twice starts one instance) and `queued` is returned with that id. When the
 * instance under that id has errored or been terminated, it is restarted, so a retry with the same
 * key is never answered by an instance that will not run.
 */
export async function gatewayCommit(
  context: GatewayContext,
  input: CommitParams,
): Promise<RpcOutput<'commit'>> {
  for (let attempt = 0; attempt <= context.config.inlineRetries; attempt += 1) {
    const outcome = await attemptCommit(context, input);
    if (outcome.kind === 'done') return outcome.output;
  }
  const workflow = context.commitWorkflow;
  if (workflow === undefined) {
    throw storageUnavailable(
      `commit to ${input.branch}`,
      'the branch kept moving and no CommitWorkflow is configured to finish the commit',
    );
  }
  const workflowInstanceId = await commitWorkflowId(input.repo, input.branch, input.idempotencyKey);
  await startWorkflowOnce(workflow, workflowInstanceId, input);
  return { status: 'queued', workflowInstanceId };
}
