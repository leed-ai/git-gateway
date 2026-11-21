// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono';

import { createGatewayApp, type GatewayAppOptions } from './gateway-app.ts';
import type { GatewayEnv } from './proxy/gateway-env.ts';

/** The fetch handler a Worker module exports. */
export interface GatewayWorker<Env> {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response>;
}

/**
 * A Worker module's fetch handler that composes the gateway from its bindings: `setup` turns the
 * environment into the app options (backend from `env.ARTIFACTS`, authenticator from JWKS
 * settings, and so on). The app is built once per environment object, so the decision cache
 * lives as long as the isolate.
 */
export function createGatewayWorker<Env extends object>(
  setup: (env: Env) => GatewayAppOptions,
): GatewayWorker<Env> {
  const apps = new WeakMap<Env, Hono<GatewayEnv>>();
  return {
    async fetch(request, env, context) {
      let app = apps.get(env);
      if (app === undefined) {
        app = createGatewayApp(setup(env));
        apps.set(env, app);
      }
      return app.fetch(request, env, context);
    },
  };
}
