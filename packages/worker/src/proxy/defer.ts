// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';

import type { Defer } from '../audit/audit-recorder.ts';

/**
 * Work to run after the response: handed to the runtime's `waitUntil` when the request has an
 * execution context (in a Worker), otherwise left to run on its own. The work must not reject.
 */
export function deferWith(context: Context): Defer {
  return (work) => {
    try {
      context.executionCtx.waitUntil(work);
    } catch {
      // No execution context (tests, Node): the promise runs to completion on its own.
    }
  };
}
