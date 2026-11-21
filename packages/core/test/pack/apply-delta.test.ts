// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { applyDelta } from '../../src/pack/apply-delta.ts';
import { deltaSize } from '../helpers/pack-builder.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

/** True when `run` throws an invalid_pack CoreError. */
function throwsInvalidPack(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return isCoreError(error, 'invalid_pack');
  }
  return false;
}

/** A copy instruction with every offset and size byte present. */
const copy = (offset: number, size: number): number[] => [
  0xff,
  offset & 0xff,
  (offset >> 8) & 0xff,
  (offset >> 16) & 0xff,
  (offset >>> 24) & 0xff,
  size & 0xff,
  (size >> 8) & 0xff,
  (size >> 16) & 0xff,
];

describe('applyDelta', () => {
  const base = bytes('hello, wonderful world');

  it('copies ranges of the base and inserts literals', () => {
    const delta = Uint8Array.from([
      ...deltaSize(base.length),
      ...deltaSize(13),
      ...copy(0, 7),
      6,
      ...bytes('there!'),
    ]);
    expect(text(applyDelta(base, delta))).toBe('hello, there!');
  });

  it('reads sparse copy instructions (only the bytes that are set)', () => {
    // 0x91: offset byte 0 and size byte 0 present.
    const delta = Uint8Array.from([...deltaSize(base.length), ...deltaSize(5), 0x91, 17, 5]);
    expect(text(applyDelta(base, delta))).toBe('world');
  });

  it('treats a copy size of zero as 65536', () => {
    const big = new Uint8Array(70_000).fill(7);
    const delta = Uint8Array.from([...deltaSize(big.length), ...deltaSize(65_536), 0x80]);
    expect(applyDelta(big, delta).length).toBe(65_536);
  });

  it('handles multi-byte sizes', () => {
    const big = new Uint8Array(300).fill(1);
    const delta = Uint8Array.from([...deltaSize(300), ...deltaSize(300), ...copy(0, 300)]);
    expect(applyDelta(big, delta)).toEqual(big);
  });

  it('rejects a delta for a base of another size', () => {
    expect(
      throwsInvalidPack(() => applyDelta(base, Uint8Array.from([...deltaSize(3), ...deltaSize(1), 1, 65]))),
    ).toBe(true);
  });

  it('rejects a header that runs out', () => {
    expect(throwsInvalidPack(() => applyDelta(base, Uint8Array.from([0x80])))).toBe(true);
    expect(throwsInvalidPack(() => applyDelta(base, Uint8Array.from(deltaSize(base.length))))).toBe(true);
  });

  it('rejects copies past the base or the result, inserts past the delta, and opcode 0', () => {
    expect(
      throwsInvalidPack(() =>
        applyDelta(base, Uint8Array.from([...deltaSize(base.length), ...deltaSize(40), ...copy(20, 10)])),
      ),
    ).toBe(true);
    expect(
      throwsInvalidPack(() =>
        applyDelta(base, Uint8Array.from([...deltaSize(base.length), ...deltaSize(2), ...copy(0, 5)])),
      ),
    ).toBe(true);
    expect(
      throwsInvalidPack(() =>
        applyDelta(base, Uint8Array.from([...deltaSize(base.length), ...deltaSize(5), 9, 65, 66])),
      ),
    ).toBe(true);
    expect(
      throwsInvalidPack(() =>
        applyDelta(base, Uint8Array.from([...deltaSize(base.length), ...deltaSize(5), 0])),
      ),
    ).toBe(true);
  });

  it('rejects a delta that produces fewer bytes than announced', () => {
    expect(
      throwsInvalidPack(() =>
        applyDelta(base, Uint8Array.from([...deltaSize(base.length), ...deltaSize(10), 2, 65, 66])),
      ),
    ).toBe(true);
  });
});
