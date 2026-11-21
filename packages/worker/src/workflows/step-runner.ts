// SPDX-License-Identifier: Apache-2.0
import type { CommitStepResult } from './commit-workflow-schemas.ts';
import type { SyncStepResult } from './sync-workflow-schemas.ts';

/** Retry and timeout settings of one Workflow step, in the shape `WorkflowStep.do` takes. */
export interface StepConfig {
  readonly retries: {
    readonly limit: number;
    readonly delay: `${number} ${'second' | 'minute'}${'s' | ''}`;
    readonly backoff: 'constant' | 'linear' | 'exponential';
  };
  readonly timeout: `${number} ${'second' | 'minute'}${'s' | ''}`;
}

/** What a gateway Workflow step stores: ids, statuses and paths, never content or a credential. */
export type StepResult = CommitStepResult | SyncStepResult;

/**
 * The part of a Workflows `WorkflowStep` the gateway's workflows use: run a named, durable step.
 * The engine stores what the callback returns and, when the instance replays after a crash or a
 * retry, hands back the stored value instead of running a finished step again. A step whose
 * result was never stored (the isolate died mid-step) runs again, so every step is idempotent.
 * The stored value comes back as `unknown`: callers parse it with its schema.
 */
export interface StepRunner {
  do(name: string, config: StepConfig, callback: () => Promise<StepResult>): Promise<unknown>;
}

/**
 * Turns an error a step cannot recover from into the error that stops the instance without
 * retries (in a Worker, `NonRetryableError` from `cloudflare:workflows`).
 */
export type FatalError = (error: Error) => Error;

/** The default {@link FatalError}: the error unchanged (for runners without a non-retryable error). */
export const keepError: FatalError = (error) => error;
