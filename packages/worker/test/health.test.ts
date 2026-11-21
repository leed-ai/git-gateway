// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { HealthResponse } from '@leed-ai/git-gateway-contract/health';

import { DEFAULT_SERVICE_NAME, healthRoutes } from '../src/health.ts';

describe('healthRoutes', () => {
  it('runs inside the Workers runtime', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('answers GET /health with a valid health response', async () => {
    const response = await healthRoutes().request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(HealthResponse.parse(await response.json())).toEqual({
      status: 'ok',
      service: DEFAULT_SERVICE_NAME,
    });
  });

  it('reports the deployment name it was given', async () => {
    const response = await healthRoutes('git.example.com').request('/health');
    expect(await response.json()).toEqual({ status: 'ok', service: 'git.example.com' });
  });

  it('rejects a service name the schema does not allow', () => {
    expect(() => healthRoutes('')).toThrow(/too small/i);
    expect(() => healthRoutes('x'.repeat(65))).toThrow(/too big/i);
  });

  it('serves nothing else', async () => {
    expect((await healthRoutes().request('/')).status).toBe(404);
    expect((await healthRoutes().request('/health', { method: 'POST' })).status).toBe(404);
  });
});
