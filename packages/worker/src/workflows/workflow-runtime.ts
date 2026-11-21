// SPDX-License-Identifier: Apache-2.0
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import type { FatalError, StepRunner } from './step-runner.ts';

/** A Workflows `WorkflowStep` as the gateway's {@link StepRunner}. */
export function stepRunnerOf(step: WorkflowStep): StepRunner {
  return { do: (name, config, callback) => step.do(name, config, callback) };
}

/** Stops a Workflow instance without retries, keeping the error's message (and any GatewayError body in it). */
export const nonRetryable: FatalError = (error) => new NonRetryableError(error.message, error.name);
