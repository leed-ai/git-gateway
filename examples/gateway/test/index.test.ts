// SPDX-License-Identifier: Apache-2.0
import { HealthResponse } from '@leed-ai/git-gateway-contract/health';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vite-plus/test';

import worker from '../src/index.ts';

const call = async (path: string, init?: RequestInit<IncomingRequestCfProperties>): Promise<Response> => {
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

  it('answers 404 for anything else', async () => {
    expect((await call('/repo.git/info/refs?service=git-upload-pack')).status).toBe(404);
  });
});
