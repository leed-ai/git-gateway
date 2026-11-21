// SPDX-License-Identifier: Apache-2.0
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { gatewayContext } from '../rpc/gateway-context.ts';
import type { GatewayOptionsResolver } from '../rpc/gateway-service.ts';
import { runSyncWorkflow } from './run-sync-workflow.ts';
import { nonRetryable, stepRunnerOf } from './workflow-runtime.ts';
import type { SyncBranchWorkflowParams, SyncStepResult } from './sync-workflow-schemas.ts';

/** The SyncBranchWorkflow class {@link createSyncBranchWorkflow} returns. */
export type SyncBranchWorkflowClass<Env> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkflowEntrypoint<Env, SyncBranchWorkflowParams> & {
  run(event: Readonly<WorkflowEvent<SyncBranchWorkflowParams>>, step: WorkflowStep): Promise<SyncStepResult>;
};

/**
 * The SyncBranchWorkflow a deployment exports and binds, which onPush sync rules start (see
 * `syncRuleHook`), e.g. to sync staging from main after every push to main:
 *
 *   export const SyncBranchWorkflow = createSyncBranchWorkflow(gatewayOptions);
 */
export function createSyncBranchWorkflow<Env>(
  resolve: GatewayOptionsResolver<Env>,
): SyncBranchWorkflowClass<Env> {
  return class SyncBranchWorkflow extends WorkflowEntrypoint<Env, SyncBranchWorkflowParams> {
    override run(
      event: Readonly<WorkflowEvent<SyncBranchWorkflowParams>>,
      step: WorkflowStep,
    ): Promise<SyncStepResult> {
      return runSyncWorkflow(
        gatewayContext(resolve(this.env)),
        event.payload,
        stepRunnerOf(step),
        nonRetryable,
      );
    }
  };
}
