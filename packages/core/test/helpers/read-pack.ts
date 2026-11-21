// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, sha1Bytes } from '../../src/bytes.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { inflate } from '../../src/pack/deflate.ts';
import type { GitObject, GitObjectType } from '../../src/schemas/git-object.ts';

const TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob' };

/** Where one zlib stream ends: tries growing prefixes until one inflates to `size` bytes. */
async function inflateAt(
  pack: Uint8Array,
  start: number,
  size: number,
): Promise<{ data: Uint8Array; end: number }> {
  for (let end = start + 2; end <= pack.length - 20; end += 1) {
    try {
      const data = await inflate(pack.subarray(start, end));
      if (data.length === size) return { data, end };
    } catch {
      // Not a complete zlib stream yet.
    }
  }
  throw new Error(`no zlib stream at ${start}`);
}

/** A minimal independent pack reader for tests: whole objects only, checksum verified. */
export async function readPack(pack: Uint8Array): Promise<GitObject[]> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK') throw new Error('bad signature');
  if (view.getUint32(4) !== 2) throw new Error('bad version');
  const trailer = bytesToHex(pack.subarray(pack.length - 20));
  if (bytesToHex(await sha1Bytes(pack.subarray(0, pack.length - 20))) !== trailer)
    throw new Error('bad checksum');
  const count = view.getUint32(8);
  const objects: GitObject[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    let byte = pack[offset] ?? 0;
    offset += 1;
    const type = TYPES[(byte >> 4) & 7];
    if (type === undefined) throw new Error('unsupported type');
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const { data, end } = await inflateAt(pack, offset, size);
    objects.push({ type, sha: await hashObject(type, data), data });
    offset = end;
  }
  if (offset !== pack.length - 20) throw new Error('trailing bytes before the checksum');
  return objects;
}
