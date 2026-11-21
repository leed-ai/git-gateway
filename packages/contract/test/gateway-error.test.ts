// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import {
  GatewayError,
  gatewayError,
  invalidInput,
  isGatewayError,
  readGatewayError,
} from '../src/gateway-error.ts';
import { GatewayErrorBody, GatewayErrorCode } from '../src/schemas/gateway-error-body.ts';

describe('GatewayError', () => {
  const error = gatewayError('path_exists', 'File already exists', { path: 'a.md' });

  it('carries a typed body and code', () => {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.name).toBe('GatewayError');
    expect(error.code).toBe('path_exists');
    expect(error.body).toEqual({
      code: 'path_exists',
      message: 'File already exists',
      details: { path: 'a.md' },
    });
  });

  it('survives a transport that keeps only the message (Workers RPC)', () => {
    const crossed = new Error(error.message);
    expect(readGatewayError(crossed)).toEqual(error.body);
    expect(isGatewayError(crossed, 'path_exists')).toBe(true);
    expect(isGatewayError(crossed, 'stale_head')).toBe(false);
  });

  it('reads null for anything that is not a gateway error', () => {
    expect(readGatewayError(new Error('boom'))).toBeNull();
    expect(readGatewayError(new Error('GatewayError {not json'))).toBeNull();
    expect(readGatewayError(new Error('GatewayError {"code":"made_up"}'))).toBeNull();
    expect(readGatewayError('GatewayError {}')).toBeNull();
    expect(isGatewayError(undefined)).toBe(false);
  });

  it('validates details against the schema', () => {
    expect(() => gatewayError('repo_not_found', 'x', { repo: 'bad/name' })).toThrow(/repo/);
  });

  it('maps Zod issues to invalid_input with dotted paths', () => {
    const result = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(result.success).toBe(false);
    const body = result.success ? null : invalidInput(result.error).body;
    expect(body).toMatchObject({ code: 'invalid_input', details: { issues: [{ path: 'a.b' }] } });
  });
});

describe('GatewayErrorCode', () => {
  it('lists exactly the codes of the GatewayErrorBody union', () => {
    const branchCodes = GatewayErrorBody.options.map((option) => option.shape.code.value);
    expect(branchCodes.toSorted()).toEqual([...GatewayErrorCode.options].toSorted());
  });
});
