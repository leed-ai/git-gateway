// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vite-plus/test';

import { createGatewayWorker } from '../src/gateway-worker.ts';
import { consoleLogger, silentLogger } from '../src/logging/logger.ts';
import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';
import { FakeBackend } from './helpers/fake-backend.ts';
import { FakeUpstream } from './helpers/fake-upstream.ts';

/** A fetch request the test worker authenticates. */
const request = (): Request =>
  new Request('https://git.example.com/site.git/info/refs?service=git-upload-pack', {
    headers: { Authorization: 'Bearer t' },
  });

describe('createGatewayWorker', () => {
  it('builds the app once per environment and keeps its decision cache', async () => {
    let setups = 0;
    let authentications = 0;
    const audits: string[] = [];
    const worker = createGatewayWorker((env: { readonly name: string }) => {
      setups += 1;
      return {
        backend: new FakeBackend(),
        authenticator: {
          authenticate: async () => {
            authentications += 1;
            return { subject: env.name };
          },
        },
        authorizer: { authorize: async () => true },
        branchPolicy: new RuleBranchPolicy(),
        audit: (event) => {
          audits.push(event.principal.subject);
        },
        logger: silentLogger,
        fetch: new FakeUpstream().fetch,
      };
    });
    const env = { name: 'deployment' };
    for (let round = 0; round < 2; round += 1) {
      const context = createExecutionContext();
      expect((await worker.fetch(request(), env, context)).status).toBe(200);
      await waitOnExecutionContext(context);
    }
    expect(setups).toBe(1);
    expect(authentications).toBe(1);
    expect(audits).toEqual(['deployment', 'deployment']);
    await worker.fetch(request(), { name: 'other' }, createExecutionContext());
    expect(setups).toBe(2);
  });
});

describe('consoleLogger', () => {
  it('writes entries as JSON lines without throwing', () => {
    expect(() => consoleLogger.log({ level: 'info', message: 'request', requestId: 'r' })).not.toThrow();
    expect(() => consoleLogger.log({ level: 'error', message: 'failed', requestId: 'r' })).not.toThrow();
  });
});
