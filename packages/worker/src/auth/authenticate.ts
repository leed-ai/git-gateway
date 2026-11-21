// SPDX-License-Identifier: Apache-2.0
import { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { MiddlewareHandler } from 'hono';

import type { GatewayDeps } from '../proxy/gateway-deps.ts';
import type { GatewayEnv } from '../proxy/gateway-env.ts';
import { textResponse, unauthorized } from '../proxy/git-responses.ts';
import {
  credentialFingerprint,
  readCredential,
} from '@leed-ai/git-gateway-contract/proxy/request-credential';

/** Milliseconds a decision about `principal` may be cached: the configured TTL, never past its expiry. */
export function decisionTtl(deps: GatewayDeps, principal: Principal): number {
  if (principal.expiresAt === null) return deps.cacheTtlMs;
  return Math.min(deps.cacheTtlMs, Date.parse(principal.expiresAt) - deps.now().getTime());
}

const expired = (deps: GatewayDeps, principal: Principal): boolean =>
  principal.expiresAt !== null && Date.parse(principal.expiresAt) <= deps.now().getTime();

/**
 * Authentication middleware: establishes the request's principal with the deployment's
 * Authenticator, through the decision cache (keyed by a SHA-256 fingerprint of the credential,
 * never the credential). No principal — or one whose credential has expired — answers 401 with
 * `WWW-Authenticate: Basic`, so git asks its credential helper and retries.
 */
export function authenticate(deps: GatewayDeps): MiddlewareHandler<GatewayEnv> {
  return async (context, next) => {
    const requestId = context.get('requestId');
    const credential = readCredential(context.req.raw);
    const key = credential === null ? null : `authn:${await credentialFingerprint(credential)}`;
    const cached = key === null ? undefined : deps.cache.get(key);
    let principal = cached?.kind === 'principal' ? cached.principal : null;
    if (principal === null) {
      try {
        const found = await deps.authenticator.authenticate(context.req.raw);
        principal = found === null ? null : Principal.parse(found);
      } catch (error) {
        deps.logger.log({
          level: 'error',
          message: 'authenticator failed',
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return textResponse(503, 'Authentication is unavailable; try again later', {
          'X-Request-Id': requestId,
        });
      }
      if (principal !== null && key !== null && !expired(deps, principal)) {
        deps.cache.set(key, { kind: 'principal', principal }, decisionTtl(deps, principal));
      }
    }
    if (principal === null || expired(deps, principal)) {
      deps.logger.log({
        level: 'info',
        message: 'authentication required',
        requestId,
        credential: credential === null ? 'none' : principal === null ? 'rejected' : 'expired',
      });
      const response = unauthorized(deps.config.realm);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
    context.set('principal', principal);
    return next();
  };
}
