// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { HealthResponse } from '@leed-ai/git-gateway-contract/health';

/** The service name reported when a deployment does not name itself. */
export const DEFAULT_SERVICE_NAME = 'git-gateway';

/** A Hono app serving `GET /health` for the given deployment name. */
export function healthRoutes(service: string = DEFAULT_SERVICE_NAME): Hono {
  const body = HealthResponse.parse({ status: 'ok', service });
  return new Hono().get('/health', (context) => context.json(body));
}
