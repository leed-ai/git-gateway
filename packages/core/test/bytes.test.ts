// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { arrayBufferBacked, bytesToHex, sha1Bytes } from '../src/bytes.ts';
import { deflate, inflate } from '../src/pack/deflate.ts';

const abc = (): Uint8Array => new TextEncoder().encode('abc');

const sharedCopyOf = (bytes: Uint8Array): Uint8Array => {
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  return shared;
};

describe('arrayBufferBacked', () => {
  it('returns an array an ArrayBuffer backs as it is, without copying', () => {
    const bytes = abc();
    expect(arrayBufferBacked(bytes)).toBe(bytes);
    const view = bytes.subarray(1);
    expect(arrayBufferBacked(view)).toBe(view);
  });

  it('copies an array over shared memory into its own ArrayBuffer', () => {
    const shared = sharedCopyOf(abc());
    const copy = arrayBufferBacked(shared);
    expect(copy).not.toBe(shared);
    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
    expect(copy).toEqual(abc());
  });

  it('lets Web Crypto and Web Streams take bytes over shared memory', async () => {
    const shared = sharedCopyOf(abc());
    expect(bytesToHex(await sha1Bytes(shared))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(await inflate(await deflate(shared))).toEqual(abc());
  });
});
