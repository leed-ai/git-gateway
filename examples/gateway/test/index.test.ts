// SPDX-License-Identifier: Apache-2.0
import { HealthResponse } from '@leed-ai/git-gateway-contract/health';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vite-plus/test';

import worker from '../src/index.ts';

type ExampleEnv = Parameters<typeof worker.fetch>[1];

/** Whether the test Worker's environment (wrangler.jsonc) carries what the example needs. */
function isExampleEnv(value: unknown): value is ExampleEnv {
  const has = (key: string): boolean => typeof value === 'object' && value !== null && key in value;
  return has('ARTIFACTS') && has('JWT_ISSUER') && has('JWT_AUDIENCE');
}

const call = async (path: string, init?: RequestInit<IncomingRequestCfProperties>): Promise<Response> => {
  if (!isExampleEnv(env)) throw new Error('wrangler.jsonc must bind ARTIFACTS and set the JWT variables');
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request<unknown, IncomingRequestCfProperties>(`https://git.example.com${path}`, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};

describe('example gateway Worker', () => {
  it('serves the health route under the deployment name', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json())).toEqual({
      status: 'ok',
      service: 'git-gateway-example',
    });
  });

  it('asks git for credentials on a repository route', async () => {
    const response = await call('/repo.git/info/refs?service=git-upload-pack');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="git-gateway-example"');
  });

  it('answers 404 for anything else', async () => {
    expect((await call('/elsewhere')).status).toBe(404);
  });
});
