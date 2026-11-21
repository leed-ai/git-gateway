// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { hexToBytes } from '../../src/bytes.ts';
import type { GitObjectType } from '../../src/schemas/git-object.ts';

/** One entry of a hand-built pack. */
export type BuiltEntry =
  | { readonly kind: 'whole'; readonly type: GitObjectType; readonly data: Uint8Array }
  | { readonly kind: 'ofs'; readonly base: number; readonly delta: Uint8Array }
  | { readonly kind: 'ref'; readonly baseSha: string; readonly delta: Uint8Array };

const CODES = { commit: 1, tree: 2, blob: 3 } as const;

function header(type: number, size: number): number[] {
  const out: number[] = [];
  let byte = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return out;
}

function ofsDistance(distance: number): number[] {
  const bytes = [distance & 0x7f];
  let rest = Math.floor(distance / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

/** Encodes a delta size header. */
export function deltaSize(size: number): number[] {
  const out: number[] = [];
  let rest = size;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

/**
 * Builds a version 2 pack by hand, deltas included, independently of the code under test:
 * node:zlib compression and node:crypto SHA-1. `count` overrides the object count in the header.
 */
export function buildPack(
  entries: readonly BuiltEntry[],
  options: { count?: number; version?: number } = {},
): Uint8Array {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(options.version ?? 2, 4);
  head.writeUInt32BE(options.count ?? entries.length, 8);
  parts.push(head);
  const offsets: number[] = [];
  let offset = 12;
  for (const entry of entries) {
    offsets.push(offset);
    let bytes: Buffer;
    if (entry.kind === 'whole') {
      bytes = Buffer.concat([
        Buffer.from(header(CODES[entry.type], entry.data.length)),
        deflateSync(entry.data),
      ]);
    } else if (entry.kind === 'ofs') {
      const distance = offset - (offsets[entry.base] ?? 0);
      bytes = Buffer.concat([
        Buffer.from(header(6, entry.delta.length)),
        Buffer.from(ofsDistance(distance)),
        deflateSync(entry.delta),
      ]);
    } else {
      bytes = Buffer.concat([
        Buffer.from(header(7, entry.delta.length)),
        Buffer.from(hexToBytes(entry.baseSha)),
        deflateSync(entry.delta),
      ]);
    }
    parts.push(bytes);
    offset += bytes.length;
  }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash('sha1').update(body).digest()]));
}
