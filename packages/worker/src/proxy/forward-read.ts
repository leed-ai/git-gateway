// SPDX-License-Identifier: Apache-2.0
import type { Handler } from 'hono';

import { deferWith } from './defer.ts';
import type { GatewayDeps } from './gateway-deps.ts';
import type { GatewayEnv } from './gateway-env.ts';
import { textResponse } from './git-responses.ts';
import { callUpstream, streamToClient } from './upstream-call.ts';

/**
 * Forwards an authorized request that writes nothing — either ref advertisement, or a fetch's
 * git-upload-pack — to the storage host and streams the answer back. Request and response bodies
 * stream through without being buffered or parsed, so protocol v2 (requested with the Git-Protocol
 * header) passes through to a host that speaks it.
 */
export function forwardRead(deps: GatewayDeps): Handler<GatewayEnv> {
  return async (context) => {
    const requestId = context.get('requestId');
    const principal = context.get('principal');
    const git = context.get('git');
    const defer = deferWith(context);
    const body = git.endpoint === 'info-refs' ? null : context.req.raw.body;
    let result;
    try {
      result = await callUpstream(deps, context, body);
    } catch (error) {
      deps.logger.log({
        level: 'error',
        message: 'storage host unreachable',
        requestId,
        repo: git.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      const reason = 'The storage backend is unreachable; try again later';
      deps.audit.record({ requestId, principal, git, outcome: 'failed', reason, refs: [] }, defer, requestId);
      return textResponse(502, reason, { 'X-Request-Id': requestId });
    }
    deps.audit.record(
      {
        requestId,
        principal,
        git,
        outcome: result.ok ? 'allowed' : 'failed',
        reason: result.ok ? null : result.reason,
        refs: [],
      },
      defer,
      requestId,
    );
    return result.ok ? streamToClient(result.response, result.response.body, requestId) : result.response;
  };
}
