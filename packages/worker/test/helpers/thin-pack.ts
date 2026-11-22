// SPDX-License-Identifier: Apache-2.0
import { concatBytes, hexToBytes, readAllBytes, sha1Bytes, streamOf } from '@leed-ai/git-gateway-core/bytes';
import { packEntryHeader } from '@leed-ai/git-gateway-core/pack/write-pack';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';

const REF_DELTA = 7;

/** A delta size varint: seven bits per byte, least significant first. */
function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return out;
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
  readAllBytes(streamOf(bytes).pipeThrough(new CompressionStream('deflate')));

/**
 * The delta instructions turning `base` into `target`, as git writes them: copy the prefix both
 * share from the base, then insert the rest of the target literally (at most 127 bytes per insert).
 */
function deltaOf(base: Uint8Array, target: Uint8Array): Uint8Array {
  let shared = 0;
  while (
    shared < base.length &&
    shared < target.length &&
    shared < 0xffffff &&
    base[shared] === target[shared]
  )
    shared += 1;
  const ops = [...varint(base.length), ...varint(target.length)];
  if (shared > 0)
    ops.push(0x80 | 0x10 | 0x20 | 0x40, shared & 0xff, (shared >> 8) & 0xff, (shared >> 16) & 0xff);
  for (let start = shared; start < target.length; start += 127) {
    const chunk = target.subarray(start, Math.min(start + 127, target.length));
    ops.push(chunk.length, ...chunk);
  }
  return Uint8Array.from(ops);
}

/** A REF_DELTA entry header: type 7 and the size of the delta data. */
function refDeltaHeader(size: number): Uint8Array {
  const bytes: number[] = [];
  let rest = size >> 4;
  let byte = (REF_DELTA << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/**
 * A thin pack, as `git push` sends one: `whole` objects written out in full, and each of `deltas`
 * written as a REF_DELTA against a `base` the pack does not carry (one the receiver already has).
 */
export async function writeThinPack(
  whole: readonly GitObject[],
  deltas: readonly { readonly base: GitObject; readonly target: GitObject }[],
): Promise<Uint8Array> {
  const entries: Uint8Array[] = [];
  for (const object of whole)
    entries.push(packEntryHeader(object.type, object.data.length), await deflate(object.data));
  for (const { base, target } of deltas) {
    const delta = deltaOf(base.data, target.data);
    entries.push(refDeltaHeader(delta.length), hexToBytes(base.sha), await deflate(delta));
  }
  const body = concatBytes([
    new TextEncoder().encode('PACK'),
    uint32(2),
    uint32(whole.length + deltas.length),
    ...entries,
  ]);
  return concatBytes([body, await sha1Bytes(body)]);
}
