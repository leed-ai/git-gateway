// SPDX-License-Identifier: Apache-2.0
import { constants, deflateSync } from 'node:zlib';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { inflateZlibAt } from '../../src/pack/zlib-inflate.ts';

const text = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n'.repeat(400));
const random = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 2_654_435_761) >>> 24);

const deflated = (data: Uint8Array, options: Parameters<typeof deflateSync>[1] = {}): Uint8Array =>
  new Uint8Array(deflateSync(data, options));

/** True when `run` throws an invalid_pack CoreError. */
function throwsInvalidPack(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return isCoreError(error, 'invalid_pack');
  }
  return false;
}

describe('inflateZlibAt', () => {
  it.each([
    ['stored blocks (level 0)', { level: 0 }],
    ['fast (level 1)', { level: 1 }],
    ['best (level 9)', { level: 9 }],
    ['fixed Huffman codes', { strategy: constants.Z_FIXED }],
    ['Huffman only', { strategy: constants.Z_HUFFMAN_ONLY }],
    ['run-length', { strategy: constants.Z_RLE }],
  ])('inflates %s and reports where the stream ends', (_name, options) => {
    for (const data of [text, random, new Uint8Array(0)]) {
      const stream = deflated(data, options);
      const padded = new Uint8Array(stream.length + 13);
      padded.set([9, 9, 9], 0);
      padded.set(stream, 3);
      const result = inflateZlibAt(padded, 3, data.length);
      expect(Buffer.from(result.data).equals(Buffer.from(data))).toBe(true);
      expect(result.end).toBe(3 + stream.length);
    }
  });

  it('round-trips any bytes at any level', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4000 }), fc.integer({ min: 0, max: 9 }), (data, level) => {
        const stream = deflated(data, { level });
        const result = inflateZlibAt(stream, 0);
        expect(Buffer.from(result.data).equals(Buffer.from(data))).toBe(true);
        expect(result.end).toBe(stream.length);
      }),
    );
  });

  it('decodes back-to-back streams one after another', () => {
    const first = deflated(text);
    const second = deflated(random);
    const joined = new Uint8Array([...first, ...second]);
    const one = inflateZlibAt(joined, 0);
    const two = inflateZlibAt(joined, one.end);
    expect(one.data.length).toBe(text.length);
    expect(two.data.length).toBe(random.length);
    expect(two.end).toBe(joined.length);
  });

  it('rejects a missing or bad header and preset dictionaries', () => {
    expect(throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x78]), 0))).toBe(true);
    expect(throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x79, 0x9c, 0, 0]), 0))).toBe(true);
    expect(throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x78, 0x9d]), 0))).toBe(true);
    expect(throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x78, 0xbb, 0, 0, 0, 0]), 0))).toBe(true);
  });

  it('rejects truncated data, a reserved block type and a bad checksum', () => {
    const stream = deflated(text);
    expect(throwsInvalidPack(() => inflateZlibAt(stream.subarray(0, stream.length - 10), 0))).toBe(true);
    expect(throwsInvalidPack(() => inflateZlibAt(stream.subarray(0, stream.length - 2), 0))).toBe(true);
    expect(throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x78, 0x9c, 0x07]), 0))).toBe(true);
    const corrupt = stream.slice();
    corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
    expect(throwsInvalidPack(() => inflateZlibAt(corrupt, 0))).toBe(true);
  });

  it('rejects a stored block whose length check fails', () => {
    expect(
      throwsInvalidPack(() => inflateZlibAt(new Uint8Array([0x78, 0x01, 0x01, 0x05, 0x00, 0x00, 0x00]), 0)),
    ).toBe(true);
  });

  it('rejects corrupt Huffman data', () => {
    // Flipping bits in the Huffman tables or codes must fail as invalid_pack, never otherwise.
    const stream = deflated(text, { level: 9 });
    const outcomes = Array.from({ length: 38 }, (_, offset) => {
      const corrupt = stream.slice();
      corrupt[offset + 2] = (corrupt[offset + 2] ?? 0) ^ 0x5a;
      try {
        inflateZlibAt(corrupt, 0);
        return 'decoded';
      } catch (error) {
        return isCoreError(error, 'invalid_pack') ? 'invalid_pack' : 'other';
      }
    });
    expect(outcomes).not.toContain('other');
    expect(outcomes.filter((outcome) => outcome === 'invalid_pack').length).toBeGreaterThan(30);
  });
});
