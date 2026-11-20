// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { applyDelta } from '../../src/pack/apply-delta.ts';
import { deltaSize } from '../helpers/pack-builder.ts';

/** "applied", or the CoreError code `run` throws, or "other" for anything else thrown. */
function outcomeOf(run: () => unknown): string {
  try {
    run();
    return 'applied';
  } catch (error) {
    return isCoreError(error) ? error.code : 'other';
  }
}

/** One delta instruction: copy a range of the base, or insert literal bytes. */
type Op = { readonly copy: readonly [offset: number, size: number] } | { readonly insert: Uint8Array };

/** Encodes a copy with only the offset and size bytes that are non-zero, as git does. */
function encodeCopy(offset: number, size: number): number[] {
  let opcode = 0x80;
  const args: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const byte = (offset >>> (8 * index)) & 0xff;
    if (byte !== 0) {
      opcode |= 1 << index;
      args.push(byte);
    }
  }
  const stored = size === 0x10000 ? 0 : size;
  for (let index = 0; index < 3; index += 1) {
    const byte = (stored >>> (8 * index)) & 0xff;
    if (byte !== 0) {
      opcode |= 0x10 << index;
      args.push(byte);
    }
  }
  return [opcode, ...args];
}

function encodeDelta(base: Uint8Array, ops: readonly Op[]): { delta: Uint8Array; expected: Uint8Array } {
  const out: number[] = [];
  const expected: number[] = [];
  for (const op of ops) {
    if ('copy' in op) {
      const [offset, size] = op.copy;
      out.push(...encodeCopy(offset, size));
      expected.push(...base.subarray(offset, offset + size));
    } else {
      out.push(op.insert.length, ...op.insert);
      expected.push(...op.insert);
    }
  }
  return {
    delta: Uint8Array.from([...deltaSize(base.length), ...deltaSize(expected.length), ...out]),
    expected: Uint8Array.from(expected),
  };
}

const opsFor = (base: Uint8Array): fc.Arbitrary<Op[]> =>
  fc.array(
    fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 127 }).map((insert): Op => ({ insert })),
      ...(base.length === 0
        ? []
        : [
            fc
              .integer({ min: 0, max: base.length - 1 })
              .chain((offset) =>
                fc
                  .integer({ min: 1, max: base.length - offset })
                  .map((size): Op => ({ copy: [offset, size] })),
              ),
          ]),
    ),
    { maxLength: 20 },
  );

describe('applyDelta (properties)', () => {
  it('reproduces the target of any sequence of copies and inserts', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 3000 }).chain((base) => fc.tuple(fc.constant(base), opsFor(base))),
        ([base, ops]) => {
          const { delta, expected } = encodeDelta(base, ops);
          expect(applyDelta(base, delta)).toEqual(expected);
        },
      ),
    );
  });

  it('copies whole 64 KiB ranges encoded with a size of zero', () => {
    const base = Uint8Array.from({ length: 0x10000 + 7 }, (_, index) => (index * 31) & 0xff);
    const { delta, expected } = encodeDelta(base, [{ copy: [7, 0x10000] }]);
    expect(applyDelta(base, delta)).toEqual(expected);
  });

  it('either applies or refuses arbitrary bytes as invalid_pack, never another error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), (base, delta) => {
        expect(['applied', 'invalid_pack']).toContain(outcomeOf(() => applyDelta(base, delta)));
      }),
    );
  });

  it('refuses a valid delta applied to a base of another length', () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 1, maxLength: 500 })
          .chain((base) => fc.tuple(fc.constant(base), opsFor(base))),
        fc.integer({ min: 1, max: 10 }),
        ([base, ops], extra) => {
          const { delta } = encodeDelta(base, ops);
          const other = new Uint8Array(base.length + extra);
          expect(outcomeOf(() => applyDelta(other, delta))).toBe('invalid_pack');
        },
      ),
    );
  });
});
