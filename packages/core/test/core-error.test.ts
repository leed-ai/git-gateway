// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { CoreError, coreError, isCoreError } from '../src/core-error.ts';
import { CoreErrorBody } from '../src/schemas/core-error-body.ts';

describe('coreError', () => {
  it('builds a typed error whose message is the body message', () => {
    const error = coreError('unsupported_request', 'Signed pushes are not supported', {
      feature: 'push-cert',
    });
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CoreError');
    expect(error.code).toBe('unsupported_request');
    expect(error.message).toBe('Signed pushes are not supported');
    expect(CoreErrorBody.parse(error.body)).toEqual(error.body);
  });

  it('validates the details against the schema', () => {
    expect(() => coreError('malformed_pkt_line', 'x', { offset: -1, reason: 'r' })).toThrow(ZodError);
  });
});

describe('isCoreError', () => {
  const error = coreError('remote_error', 'Remote error: no', { remoteMessage: 'no' });

  it('recognises a core error, optionally by code', () => {
    expect(isCoreError(error)).toBe(true);
    expect(isCoreError(error, 'remote_error')).toBe(true);
    expect(isCoreError(error, 'missing_object')).toBe(false);
  });

  it('rejects anything else', () => {
    expect(isCoreError(new Error('remote_error'))).toBe(false);
    expect(isCoreError({ code: 'remote_error' })).toBe(false);
    expect(isCoreError(undefined)).toBe(false);
  });
});
