// SPDX-License-Identifier: Apache-2.0
import { constants, deflateSync } from 'node:zlib';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { StreamInflater } from '../../src/pack/stream-inflater.ts';

const text = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n'.repeat(4000));
const random = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 2_654_435_761) >>> 24);

const deflated = (data: Uint8Array, options: Parameters<typeof deflateSync>[1] = {}): Uint8Array =>
  new Uint8Array(deflateSync(data, options));

/** Splits bytes into chunks of the given sizes (cycled), as a network would deliver them. */
function chunked(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = Math.max(1, sizes[index % sizes.length] ?? 1);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

/** Feeds chunks until the stream ends; returns the inflater and everything after the stream. */
function feed(inflater: StreamInflater, chunks: readonly Uint8Array[]): { rest: Uint8Array; fed: number } {
  for (let index = 0; index < chunks.length; index += 1) {
    const rest = inflater.push(chunks[index] ?? new Uint8Array(0));
    if (rest !== null) return { rest: concatBytes([rest, ...chunks.slice(index + 1)]), fed: index + 1 };
  }
  return { rest: new Uint8Array(0), fed: chunks.length };
}

function throwsInvalidPack(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return isCoreError(error, 'invalid_pack');
  }
  return false;
}

describe('StreamInflater', () => {
  it.each([
    ['stored blocks (level 0)', { level: 0 }],
    ['fast (level 1)', { level: 1 }],
    ['best (level 9)', { level: 9 }],
    ['fixed Huffman codes', { strategy: constants.Z_FIXED }],
    ['Huffman only', { strategy: constants.Z_HUFFMAN_ONLY }],
    ['run-length', { strategy: constants.Z_RLE }],
  ])('inflates %s fed one byte at a time and finds the end', (_name, options) => {
    for (const data of [text, random.subarray(0, 40_000), new Uint8Array(0)]) {
      const stream = deflated(data, options);
      const inflater = new StreamInflater({ keep: data.length });
      const { rest } = feed(inflater, chunked(concatBytes([stream, Uint8Array.of(7, 8, 9)]), [1]));
      expect(inflater.done).toBe(true);
      expect(inflater.outputLength).toBe(data.length);
      expect(Buffer.from(inflater.result()).equals(Buffer.from(data))).toBe(true);
      expect([...rest]).toEqual([7, 8, 9]);
    }
  });

  it('keeps only the window when not asked to keep the output', () => {
    const inflater = new StreamInflater();
    const { rest } = feed(inflater, chunked(deflated(random), [65_536]));
    expect(inflater.done).toBe(true);
    expect(inflater.outputLength).toBe(random.length);
    expect(inflater.result()).toEqual(new Uint8Array(0));
    expect(rest).toEqual(new Uint8Array(0));
  });

  it('returns null while the stream is incomplete and refuses input after the end', () => {
    const stream = deflated(text);
    const inflater = new StreamInflater();
    expect(inflater.push(stream.subarray(0, stream.length - 1))).toBeNull();
    expect(inflater.done).toBe(false);
    expect(inflater.push(stream.subarray(stream.length - 1))).toEqual(new Uint8Array(0));
    expect(() => inflater.push(Uint8Array.of(1))).toThrow(/already ended/);
  });

  it('rejects a bad header, a preset dictionary, a reserved block type and a wrong checksum', () => {
    expect(throwsInvalidPack(() => new StreamInflater().push(Uint8Array.of(0x78, 0x00)))).toBe(true);
    expect(throwsInvalidPack(() => new StreamInflater().push(Uint8Array.of(0x78, 0xbb, 0, 0, 0, 0)))).toBe(
      true,
    );
    expect(throwsInvalidPack(() => new StreamInflater().push(Uint8Array.of(0x78, 0x9c, 0x07)))).toBe(true);
    const stream = deflated(text);
    stream[stream.length - 1] = (stream[stream.length - 1] ?? 0) ^ 1;
    expect(throwsInvalidPack(() => new StreamInflater().push(stream))).toBe(true);
  });

  it('rejects a stored block whose length check fails and a back-reference before the output', () => {
    expect(
      throwsInvalidPack(() => new StreamInflater().push(Uint8Array.of(0x78, 0x01, 0x01, 5, 0, 0, 0))),
    ).toBe(true);
    // A fixed-Huffman block starting with a length/distance pair: nothing to copy from yet.
    expect(throwsInvalidPack(() => new StreamInflater().push(Uint8Array.of(0x78, 0x01, 0x03, 0x02)))).toBe(
      true,
    );
  });

  it('refuses to keep more than it was asked to', () => {
    const inflater = new StreamInflater({ keep: 10 });
    expect(throwsInvalidPack(() => inflater.push(deflated(text)))).toBe(true);
    const stored = new StreamInflater({ keep: 10 });
    expect(throwsInvalidPack(() => stored.push(deflated(text, { level: 0 })))).toBe(true);
  });

  it('agrees with zlib for any data, level and chunking (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 3000 }),
        fc.integer({ min: 0, max: 9 }),
        fc.array(fc.integer({ min: 1, max: 700 }), { minLength: 1, maxLength: 8 }),
        fc.uint8Array({ maxLength: 16 }),
        (data, level, sizes, trailing) => {
          const stream = deflated(data, { level });
          const inflater = new StreamInflater({ keep: data.length });
          const { rest } = feed(inflater, chunked(concatBytes([stream, trailing]), sizes));
          expect(inflater.done).toBe(true);
          expect([...inflater.result()]).toEqual([...data]);
          expect([...rest]).toEqual([...trailing]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
