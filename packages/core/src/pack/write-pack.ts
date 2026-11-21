// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { z } from 'zod';

import { concatBytes, sha1Bytes } from '../bytes.ts';
import { GitObject, type GitObjectType } from '../schemas/git-object.ts';
import { deflate } from './deflate.ts';

/** The type number a pack entry header carries for each object type. */
export const PACK_TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3 };

/**
 * The variable-length header of a pack entry: type in bits 4–6 of the first byte, the size in the
 * low four bits of the first byte and seven bits of each following byte, least significant first,
 * the top bit flagging that another byte follows.
 */
export function packEntryHeader(type: GitObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  let byte = (PACK_TYPE_CODES[type] << 4) | (size % 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest % 128;
    rest = Math.floor(rest / 128);
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
 * Writes a version 2 pack of whole (undeltified) objects: "PACK", version, object count, each
 * object as an entry header plus its zlib-compressed content, then the SHA-1 of everything before
 * it. An object listed twice (same id) is written once. The result passes
 * `git index-pack --strict` when the objects themselves are valid.
 */
export async function writePack(objects: readonly GitObject[]): Promise<Uint8Array> {
  const unique = new Map<string, GitObject>();
  for (const object of z.array(GitObject).parse(objects)) {
    if (!unique.has(object.sha)) unique.set(object.sha, object);
  }
  const entries = await Promise.all(
    [...unique.values()].map(async (object) =>
      concatBytes([packEntryHeader(object.type, object.data.length), await deflate(object.data)]),
    ),
  );
  const body = concatBytes([utf8('PACK'), uint32(2), uint32(unique.size), ...entries]);
  return concatBytes([body, await sha1Bytes(body)]);
}
