// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { HealthResponse } from '../../src/health.ts';

// The wire contract of GET /health: consumers validate against this shape, so it only ever grows.
describe('HealthResponse contract', () => {
  it('accepts a well-formed response', () => {
    expect(HealthResponse.parse({ status: 'ok', service: 'git-gateway' })).toEqual({
      status: 'ok',
      service: 'git-gateway',
    });
  });

  it('rejects unknown fields, so additions are deliberate', () => {
    expect(HealthResponse.safeParse({ status: 'ok', service: 'git-gateway', extra: 1 }).success).toBe(false);
  });

  it('keeps a stable JSON Schema', () => {
    expect(z.toJSONSchema(HealthResponse)).toMatchSnapshot();
  });
});
