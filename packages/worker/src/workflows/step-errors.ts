// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';

import type { FatalError } from './step-runner.ts';

/** Thrown inside a step when the branch moved under it, so the engine retries the step with backoff. */
export class BranchMovedError extends Error {
  override readonly name = 'BranchMovedError';

  constructor(branch: string) {
    super(`Branch ${branch} moved during the step; retrying`);
  }
}

/**
 * Sorts an error thrown inside a step: a GatewayError that retrying cannot fix (any code but
 * storage_unavailable — a rule broken by the actions, a missing branch, a stale expected head) is
 * turned into a fatal error so the instance stops at once, keeping the GatewayError's message (and
 * so its body). Everything else — storage failures, a moved branch, the unexpected — is rethrown
 * as is for the engine to retry.
 */
export function classifyStepError(thrown: unknown, fatal: FatalError): unknown {
  const body = readGatewayError(thrown);
  if (body === null || body.code === 'storage_unavailable' || !(thrown instanceof Error)) return thrown;
  return fatal(thrown);
}
