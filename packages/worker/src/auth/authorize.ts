// SPDX-License-Identifier: Apache-2.0
import type { MiddlewareHandler } from 'hono';

import type { GatewayDeps } from '../proxy/gateway-deps.ts';
import type { GatewayEnv } from '../proxy/gateway-env.ts';
import { deferWith } from '../proxy/defer.ts';
import { errResponse, textResponse } from '../proxy/git-responses.ts';
import { decisionTtl } from './authenticate.ts';

/**
 * Authorization middleware: asks the deployment's Authorizer whether the principal may read
 * (fetch) or write (push) the repository, through the decision cache keyed by principal subject
 * and roles, repository and operation. A refusal is audited and answered as `smartHttp.deniedStatus`
 * says: in-protocol with an "ERR" packet (default), so git prints "remote error: …", or HTTP 403
 * with the reason as the body.
 */
export function authorize(deps: GatewayDeps): MiddlewareHandler<GatewayEnv> {
  return async (context, next) => {
    const requestId = context.get('requestId');
    const principal = context.get('principal');
    const git = context.get('git');
    const key = `authz:${principal.subject}\u0000${principal.roles.join(' ')}\u0000${git.repo}\u0000${git.operation}`;
    const cached = deps.cache.get(key);
    let allowed = cached?.kind === 'allowed' ? cached.allowed : null;
    if (allowed === null) {
      try {
        allowed = await deps.authorizer.authorize(principal, git.repo, git.operation);
      } catch (error) {
        deps.logger.log({
          level: 'error',
          message: 'authorizer failed',
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return textResponse(503, 'Authorization is unavailable; try again later', {
          'X-Request-Id': requestId,
        });
      }
      deps.cache.set(key, { kind: 'allowed', allowed }, decisionTtl(deps, principal));
    }
    if (!allowed) {
      const reason = `access denied: ${principal.subject} may not ${git.operation === 'read' ? 'read' : 'push to'} ${git.repo}`;
      deps.audit.record(
        { requestId, principal, git, outcome: 'denied', reason, refs: [] },
        deferWith(context),
        requestId,
      );
      if (deps.config.deniedStatus === 403) {
        return textResponse(403, reason, { 'X-Request-Id': requestId });
      }
      const response = errResponse(git.service, git.endpoint === 'info-refs' ? 'info-refs' : 'rpc', reason);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
    return next();
  };
}
