// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { decodeBase64Url, encodeBase64Url } from '../src/base64url.ts';

describe('base64url', () => {
  it('round-trips any bytes without padding (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const text = encodeBase64Url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect([...decodeBase64Url(text)]).toEqual([...bytes]);
      }),
    );
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => decodeBase64Url('ab+c')).toThrow(/base64url/);
    expect(() => decodeBase64Url('ab=c')).toThrow(/base64url/);
  });
});
