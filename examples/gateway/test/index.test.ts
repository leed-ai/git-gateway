// SPDX-License-Identifier: Apache-2.0
import { ArtifactsBackend } from '@leed-ai/git-gateway-backend-artifacts/artifacts-backend';
import { HealthResponse } from '@leed-ai/git-gateway-contract/health';
import { mintReadToken } from '@leed-ai/git-gateway-worker/rpc/read-token';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vite-plus/test';

import worker from '../src/index.ts';

type ExampleEnv = Parameters<typeof worker.fetch>[1];

/** Whether the test Worker's environment (wrangler.jsonc) carries what the example needs. */
function isExampleEnv(value: unknown): value is ExampleEnv {
  const has = (key: string): boolean => typeof value === 'object' && value !== null && key in value;
  return (
    has('ARTIFACTS') &&
    has('JWT_ISSUER') &&
    has('JWT_AUDIENCE') &&
    has('PUBLIC_BASE_URL') &&
    has('READ_TOKEN_SECRET')
  );
}

function exampleEnv(): ExampleEnv {
  if (!isExampleEnv(env)) {
    throw new Error(
      'wrangler.jsonc must bind ARTIFACTS and set the variables; vite.config.ts the test secret',
    );
  }
  return env;
}

const call = async (path: string, init?: RequestInit<IncomingRequestCfProperties>): Promise<Response> => {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request<unknown, IncomingRequestCfProperties>(`https://git.example.com${path}`, init),
    exampleEnv(),
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

  it('lets a read token from mintReadToken() fetch its repository, and nothing more', async () => {
    const { ARTIFACTS, READ_TOKEN_SECRET } = exampleEnv();
    const repo = `example-${crypto.randomUUID().slice(0, 8)}`;
    const backend = new ArtifactsBackend({ binding: ARTIFACTS });
    await backend.createRepo(repo);
    try {
      const { token } = await mintReadToken({
        repo,
        ttlSeconds: 300,
        secret: READ_TOKEN_SECRET,
        now: new Date(),
      });
      const headers = { Authorization: `Basic ${btoa(`git:${token}`)}` };
      const fetchRefs = await call(`/${repo}.git/info/refs?service=git-upload-pack`, { headers });
      expect(fetchRefs.status).toBe(200);
      expect(await fetchRefs.text()).toContain('# service=git-upload-pack');
      const pushRefs = await call(`/${repo}.git/info/refs?service=git-receive-pack`, { headers });
      expect(await pushRefs.text()).toContain(`may not push to ${repo}`);
      const elsewhere = await call('/other.git/info/refs?service=git-upload-pack', { headers });
      expect(await elsewhere.text()).toContain('may not read other');
    } finally {
      await backend.deleteRepo(repo);
    }
  });

  it('answers 404 for anything else', async () => {
    expect((await call('/elsewhere')).status).toBe(404);
  });
});
