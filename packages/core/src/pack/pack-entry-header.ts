// SPDX-License-Identifier: Apache-2.0
import { bytesToHex } from '../bytes.ts';
import { coreError } from '../core-error.ts';

/** Pack entry type codes (git's object_type). */
const OFS_DELTA = 6;
const REF_DELTA = 7;
/** A size varint longer than this cannot describe a real object. */
const MAX_SIZE_BYTES = 10;

/** The start of a pack entry: its type, inflated size and delta base, and how long its header was. */
export type EntryStart = {
  /** Offset of the entry in the pack. */
  readonly offset: number;
  /** Size of the entry's inflated data (the object, or the delta). */
  readonly size: number;
  /** Bytes of header (type and size, and the delta base) before the zlib stream. */
  readonly headerLength: number;
} & (
  | { readonly kind: 'whole'; readonly type: 1 | 2 | 3 }
  | { readonly kind: 'ofs'; readonly type: 6; readonly baseOffset: number }
  | { readonly kind: 'ref'; readonly type: 7; readonly baseSha: string }
);

function badPack(reason: string, offset: number): Error {
  return coreError('invalid_pack', 'Invalid pack', { offset, reason });
}

/**
 * Reads the header of the pack entry at the start of `bytes` (which sits at `offset` in the
 * pack): type and size, then the OFS_DELTA distance or REF_DELTA base id. Returns null when
 * `bytes` ends inside the header. Throws invalid_pack for an unknown type or a bad base offset.
 */
export function readEntryStart(bytes: Uint8Array, offset: number): EntryStart | null {
  let at = 0;
  let byte = bytes[at];
  if (byte === undefined) return null;
  at += 1;
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (at >= MAX_SIZE_BYTES) throw badPack('an entry size is too long', offset);
    byte = bytes[at];
    if (byte === undefined) return null;
    at += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (type === 1 || type === 2 || type === 3) return { kind: 'whole', type, size, offset, headerLength: at };
  if (type === REF_DELTA) {
    if (bytes.length < at + 20) return null;
    const baseSha = bytesToHex(bytes.subarray(at, at + 20));
    return { kind: 'ref', type, size, offset, baseSha, headerLength: at + 20 };
  }
  if (type !== OFS_DELTA) throw badPack(`unknown entry type ${type}`, offset);
  byte = bytes[at];
  if (byte === undefined) return null;
  at += 1;
  let distance = byte & 0x7f;
  let length = 1;
  while ((byte & 0x80) !== 0) {
    if (length >= MAX_SIZE_BYTES) throw badPack('an OFS_DELTA distance is too long', offset);
    byte = bytes[at];
    if (byte === undefined) return null;
    at += 1;
    length += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  const baseOffset = offset - distance;
  if (distance === 0 || baseOffset < 12) {
    throw badPack(`an OFS_DELTA base offset ${baseOffset} is outside the pack`, offset);
  }
  return { kind: 'ofs', type, size, offset, baseOffset, headerLength: at };
}
