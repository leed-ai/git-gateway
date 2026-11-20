// SPDX-License-Identifier: Apache-2.0
import { healthRoutes } from '@leed-ai/git-gateway-worker/health';

/** The example deployment: today it serves the health route; later releases compose the full gateway here. */
const app = healthRoutes('git-gateway-example');

export default {
  fetch: (request, env, context) => app.fetch(request, env, context),
} satisfies ExportedHandler;
