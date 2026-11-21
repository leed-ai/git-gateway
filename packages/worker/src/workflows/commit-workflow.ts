// SPDX-License-Identifier: Apache-2.0
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { gatewayContext } from '../rpc/gateway-context.ts';
import type { GatewayOptionsResolver } from '../rpc/gateway-service.ts';
import type { CommitStepResult, CommitWorkflowParams } from './commit-workflow-schemas.ts';
import { runCommitWorkflow } from './run-commit-workflow.ts';
import { nonRetryable, stepRunnerOf } from './workflow-runtime.ts';

/** The CommitWorkflow class {@link createCommitWorkflow} returns. */
export type CommitWorkflowClass<Env> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkflowEntrypoint<Env, CommitWorkflowParams> & {
  run(event: Readonly<WorkflowEvent<CommitWorkflowParams>>, step: WorkflowStep): Promise<CommitStepResult>;
};

/**
 * The CommitWorkflow a deployment exports and binds (as the `commitWorkflow` of its options), to
 * finish commits whose inline retries ran out. Built from the same options resolver as the RPC
 * entrypoint, so both write through the same backend and configuration:
 *
 *   export const CommitWorkflow = createCommitWorkflow(gatewayOptions);
 */
export function createCommitWorkflow<Env>(resolve: GatewayOptionsResolver<Env>): CommitWorkflowClass<Env> {
  return class CommitWorkflow extends WorkflowEntrypoint<Env, CommitWorkflowParams> {
    override run(
      event: Readonly<WorkflowEvent<CommitWorkflowParams>>,
      step: WorkflowStep,
    ): Promise<CommitStepResult> {
      return runCommitWorkflow(
        gatewayContext(resolve(this.env)),
        event.payload,
        stepRunnerOf(step),
        nonRetryable,
      );
    }
  };
}
