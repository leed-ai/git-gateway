// SPDX-License-Identifier: Apache-2.0
import { coreError } from '../core-error.ts';

function badDelta(reason: string, offset: number): Error {
  return coreError('invalid_pack', 'Invalid delta', { offset, reason });
}

/** Reads a delta header size: seven bits per byte, least significant first, top bit = more. */
function readSize(delta: Uint8Array, start: number): [number, number] {
  let size = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = delta[offset];
    if (byte === undefined) throw badDelta('the delta ends inside its header', offset);
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [size, offset];
  }
}

/**
 * Applies a git delta (the payload of an OFS_DELTA or REF_DELTA pack entry) to its base object:
 * the base size and result size, then copy instructions (byte ranges of the base) and insert
 * instructions (literal bytes). Throws an invalid_pack CoreError when the delta does not match
 * the base or its instructions run out of range.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const [baseSize, afterBase] = readSize(delta, 0);
  if (baseSize !== base.length) {
    throw badDelta(`the delta expects a ${baseSize}-byte base, the base has ${base.length}`, 0);
  }
  const [resultSize, start] = readSize(delta, afterBase);
  const out = new Uint8Array(resultSize);
  let written = 0;
  let offset = start;
  while (offset < delta.length) {
    const opcode = delta[offset] ?? 0;
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          copyOffset += (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          copySize += (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (offset > delta.length || copyOffset + copySize > base.length || written + copySize > resultSize) {
        throw badDelta('a copy instruction runs past the base or the result', offset);
      }
      out.set(base.subarray(copyOffset, copyOffset + copySize), written);
      written += copySize;
    } else if (opcode !== 0) {
      if (offset + opcode > delta.length || written + opcode > resultSize) {
        throw badDelta('an insert instruction runs past the delta or the result', offset);
      }
      out.set(delta.subarray(offset, offset + opcode), written);
      written += opcode;
      offset += opcode;
    } else {
      throw badDelta('reserved delta opcode 0', offset - 1);
    }
  }
  if (written !== resultSize) throw badDelta(`the delta produced ${written} of ${resultSize} bytes`, offset);
  return out;
}
