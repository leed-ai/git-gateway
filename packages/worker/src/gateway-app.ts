// SPDX-License-Identifier: Apache-2.0
import type {
  AuditHook,
  Authenticator,
  Authorizer,
  BranchPolicy,
} from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import {
  SmartHttpConfig,
  type SmartHttpConfigInput,
} from '@leed-ai/git-gateway-contract/proxy/smart-http-config';
import { GatewayConfig, type GatewayConfigInput } from '@leed-ai/git-gateway-contract/schemas/gateway-config';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { Hono } from 'hono';

import { AuditRecorder } from './audit/audit-recorder.ts';
import { authenticate } from './auth/authenticate.ts';
import { authorize } from './auth/authorize.ts';
import { DecisionCache } from './cache/decision-cache.ts';
import { DEFAULT_SERVICE_NAME, healthRoutes } from './health.ts';
import { silentLogger, type Logger } from './logging/logger.ts';
import { enforceBranchPolicy } from './policy/enforce-branch-policy.ts';
import { forwardRead } from './proxy/forward-read.ts';
import type { CachedDecision, GatewayDeps } from './proxy/gateway-deps.ts';
import type { GatewayEnv } from './proxy/gateway-env.ts';
import { textResponse } from './proxy/git-responses.ts';
import { receivePack } from './proxy/receive-pack.ts';
import { requestLog } from './proxy/request-log.ts';
import { resolveRoute } from './proxy/resolve-route.ts';
import type { UpstreamFetch } from './proxy/upstream.ts';
import { composeOnPush, type OnPushHook } from './workflows/on-push.ts';
import type { SyncBranchWorkflowParams } from './workflows/sync-workflow-schemas.ts';
import type { WorkflowStarter } from './workflows/workflow-starter.ts';

/** What a deployment composes the gateway from. */
export interface GatewayAppOptions {
  /** Where the repositories are stored; mints the per-request upstream credential. */
  readonly backend: StorageBackend;
  /** Establishes who each request acts for (e.g. `JwtAuthenticator`). */
  readonly authenticator: Authenticator;
  /** Decides read and write access per principal and repository. */
  readonly authorizer: Authorizer;
  /** Decides which refs a push may update (e.g. `RuleBranchPolicy`). */
  readonly branchPolicy: BranchPolicy;
  /** Receives every authenticated operation; optional. */
  readonly audit?: AuditHook;
  /**
   * Called after every push the storage host accepted through the proxy, with the refs its
   * report-status marked "ok" (refused refs are left out; a push refused outright sends nothing),
   * beside the sync rules, e.g. to send the event to a Queue. It runs after the response is under
   * way (through `waitUntil`); a failure is logged, passed to {@link onPushError} and never
   * changes the response.
   */
  readonly onPush?: OnPushHook;
  /** Receives onPush failures after they are logged, e.g. to count them; default: nothing more. */
  readonly onPushError?: (error: unknown) => void;
  /**
   * The SyncBranchWorkflow binding `gateway.syncRules` start instances of after every accepted
   * push to a rule's `from` branch; required when there are sync rules.
   */
  readonly syncWorkflow?: WorkflowStarter<SyncBranchWorkflowParams>;
  /** Structured logs; default none (pass `consoleLogger` in a Worker). */
  readonly logger?: Logger;
  /** Shared gateway settings; `authCacheSeconds` sets how long decisions are cached. */
  readonly gateway?: GatewayConfigInput;
  /** Smart-HTTP limits and the auth realm. */
  readonly smartHttp?: SmartHttpConfigInput;
  /** Name reported by GET /health; default "git-gateway". */
  readonly serviceName?: string;
  /** How requests reach the storage host; default the global `fetch`. */
  readonly fetch?: UpstreamFetch;
  /** The clock; default the system clock. */
  readonly now?: () => Date;
}

/**
 * The gateway as a Hono app: GET /health, and git smart HTTP at `/<repo>.git/info/refs`,
 * `/<repo>.git/git-upload-pack` and `/<repo>.git/git-receive-pack`, each running route
 * resolution → authentication → authorization (→ branch policy for pushes) as middleware before
 * the request is proxied, streamed, to the storage host with a credential minted for it alone.
 * Accepted pushes are delivered to the onPush hook and the sync rules after the response. Throws
 * a TypeError when `gateway.syncRules` are set without a `syncWorkflow`. Create it once per
 * isolate: it holds the decision cache.
 */
export function createGatewayApp(options: GatewayAppOptions): Hono<GatewayEnv> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const config = SmartHttpConfig.parse(options.smartHttp ?? {});
  const gateway = GatewayConfig.parse(options.gateway ?? {});
  const deps: GatewayDeps = {
    backend: options.backend,
    authenticator: options.authenticator,
    authorizer: options.authorizer,
    branchPolicy: options.branchPolicy,
    audit: new AuditRecorder(options.audit, logger, now),
    logger,
    cache: new DecisionCache<CachedDecision>({
      maxEntries: config.decisionCacheEntries,
      now: () => now().getTime(),
    }),
    config,
    cacheTtlMs: gateway.authCacheSeconds * 1000,
    fetch: options.fetch ?? (async (request) => fetch(request)),
    now,
    onPush: composeOnPush({
      syncRules: gateway.syncRules,
      syncWorkflow: options.syncWorkflow,
      onPush: options.onPush,
    }),
    onPushError: options.onPushError ?? (() => undefined),
  };
  const app = new Hono<GatewayEnv>();
  app.use('*', requestLog(logger, now));
  app.route('/', healthRoutes(options.serviceName ?? DEFAULT_SERVICE_NAME));
  const git = new Hono<GatewayEnv>();
  const policy = enforceBranchPolicy(deps);
  const read = forwardRead(deps);
  const write = receivePack(deps);
  git.use('*', resolveRoute(), authenticate(deps), authorize(deps));
  git.use('*', async (context, next) =>
    context.get('git').endpoint === 'receive-pack' ? policy(context, next) : next(),
  );
  git.all('*', async (context, next) =>
    context.get('git').endpoint === 'receive-pack' ? write(context, next) : read(context, next),
  );
  app.route('/', git);
  app.notFound(() => textResponse(404, 'Not found'));
  app.onError((error, context) => {
    logger.log({
      level: 'error',
      message: 'unhandled error',
      requestId: context.get('requestId'),
      error: error instanceof Error ? error.message : String(error),
    });
    return textResponse(500, 'Internal error', { 'X-Request-Id': context.get('requestId') });
  });
  return app;
}
