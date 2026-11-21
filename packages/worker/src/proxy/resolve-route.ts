// SPDX-License-Identifier: Apache-2.0
import type { MiddlewareHandler } from 'hono';

import type { GatewayEnv } from './gateway-env.ts';
import { textResponse } from './git-responses.ts';
import { resolveGitRequest } from './git-route.ts';

/**
 * Route middleware for `/<repo>.git/…`: resolves the repository and endpoint and checks the
 * method, before any authentication. Dumb HTTP (info/refs without a smart service) is refused
 * with 403, as git-http-backend does; unknown paths and invalid repository names are 404.
 */
export function resolveRoute(): MiddlewareHandler<GatewayEnv> {
  return async (context, next) => {
    const resolved = resolveGitRequest(new URL(context.req.url));
    if (resolved === 'not-found') return textResponse(404, 'Not found');
    if (resolved === 'dumb-http')
      return textResponse(403, 'Dumb HTTP is not supported; use a smart git client');
    const expected = resolved.endpoint === 'info-refs' ? 'GET' : 'POST';
    if (context.req.method !== expected) return textResponse(405, 'Method not allowed', { Allow: expected });
    context.set('git', resolved);
    return next();
  };
}
