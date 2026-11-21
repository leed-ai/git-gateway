// SPDX-License-Identifier: Apache-2.0
import { RequestId } from '@leed-ai/git-gateway-contract/proxy/audit-event';
import type { MiddlewareHandler } from 'hono';

import type { Logger } from '../logging/logger.ts';
import type { GatewayEnv } from './gateway-env.ts';

/** The id of a request: its Cloudflare Ray id when it has a valid one, otherwise a random UUID. */
export function requestIdOf(request: Request): string {
  const ray = RequestId.safeParse(request.headers.get('CF-Ray'));
  return ray.success ? ray.data : crypto.randomUUID();
}

/**
 * The first middleware: gives the request an id (returned as X-Request-Id) and writes one
 * structured log entry when it is answered — method, path, status, duration, repository,
 * endpoint and principal subject. Never the query string beyond `service`, never a header value,
 * never a credential.
 */
export function requestLog(logger: Logger, now: () => Date): MiddlewareHandler<GatewayEnv> {
  return async (context, next) => {
    const requestId = requestIdOf(context.req.raw);
    context.set('requestId', requestId);
    const started = now().getTime();
    await next();
    context.res.headers.set('X-Request-Id', requestId);
    const url = new URL(context.req.url);
    const git = context.get('git') as GatewayEnv['Variables']['git'] | undefined;
    const principal = context.get('principal') as GatewayEnv['Variables']['principal'] | undefined;
    logger.log({
      level: context.res.status >= 500 ? 'error' : 'info',
      message: 'request',
      requestId,
      method: context.req.method,
      path: url.pathname,
      service: url.searchParams.get('service'),
      status: context.res.status,
      durationMs: now().getTime() - started,
      repo: git?.repo ?? null,
      endpoint: git?.endpoint ?? null,
      principal: principal?.subject ?? null,
    });
  };
}
