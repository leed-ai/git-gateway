// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { isUnserializableBlob } from '../src/artifacts-git-reads.ts';

describe('isUnserializableBlob', () => {
  it('matches only the remote binding failing to carry a Blob back', () => {
    expect(isUnserializableBlob(new Error('Cannot serialize value: [object Blob]'))).toBe(true);
    expect(
      isUnserializableBlob(new TypeError('Internal error: Cannot serialize value: [object Blob].')),
    ).toBe(true);
    expect(isUnserializableBlob(new Error('Cannot serialize value: [object Object]'))).toBe(false);
    expect(isUnserializableBlob(new Error('Repository not found: x.'))).toBe(false);
    expect(isUnserializableBlob('Cannot serialize value: [object Blob]')).toBe(false);
    expect(isUnserializableBlob(null)).toBe(false);
  });
});
