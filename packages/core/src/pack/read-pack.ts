// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, sha1Bytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { createObject } from '../objects/hash-object.ts';
import type { GitObject, GitObjectType } from '../schemas/git-object.ts';
import { applyDelta, deltaResultSize } from './apply-delta.ts';
import { inflateZlibAt } from './zlib-inflate.ts';

const TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob' };
const OFS_DELTA = 6;
const REF_DELTA = 7;
/** The object count a pack may claim; more than any real push, and bounds the work a hostile pack causes. */
export const MAX_PACK_OBJECTS = 10_000_000;

/** Finds a REF_DELTA base outside the pack (a thin pack's base already in the repository). */
export type BaseLookup = (sha: string) => Promise<GitObject | null>;

/** Options of {@link readPack}. */
export interface ReadPackOptions {
  /** Resolves REF_DELTA bases the pack does not contain. Without it such a base is an error. */
  readonly lookupBase?: BaseLookup;
  /**
   * Most bytes the read may decompress and rebuild in all: every entry's inflated data plus
   * every delta's result. A pack needing more throws unsupported_request before the memory is
   * spent. Default: no limit.
   */
  readonly maxObjectBytes?: number;
}

/** Counts bytes against {@link ReadPackOptions.maxObjectBytes}. */
type Spend = (bytes: number) => void;

function spender(limit: number | undefined): Spend {
  let spent = 0;
  return (bytes) => {
    spent += bytes;
    if (limit !== undefined && spent > limit) {
      throw coreError('unsupported_request', 'The pack is too large to read', {
        feature: `more than ${limit} bytes of objects in one pack`,
      });
    }
  };
}

function badPack(reason: string, offset: number): Error {
  return coreError('invalid_pack', 'Invalid pack', { offset, reason });
}

/** One entry as stored: a whole object, or a delta waiting for its base. */
type RawEntry =
  | {
      readonly kind: 'whole';
      readonly offset: number;
      readonly type: GitObjectType;
      readonly data: Uint8Array;
    }
  | { readonly kind: 'ofs'; readonly offset: number; readonly baseOffset: number; readonly delta: Uint8Array }
  | { readonly kind: 'ref'; readonly offset: number; readonly baseSha: string; readonly delta: Uint8Array };

function readEntryHeader(pack: Uint8Array, start: number): { type: number; size: number; next: number } {
  let offset = start;
  let byte = pack[offset] ?? 0;
  offset += 1;
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (offset >= pack.length - 20) throw badPack('an entry header runs into the checksum', offset);
    byte = pack[offset] ?? 0;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: offset };
}

function readOfsBase(
  pack: Uint8Array,
  start: number,
  entryOffset: number,
): { baseOffset: number; next: number } {
  let offset = start;
  let byte = pack[offset] ?? 0;
  offset += 1;
  let distance = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = pack[offset] ?? 0;
    offset += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  const baseOffset = entryOffset - distance;
  if (distance === 0 || baseOffset < 12)
    throw badPack(`an OFS_DELTA base offset ${baseOffset} is outside the pack`, start);
  return { baseOffset, next: offset };
}

function readEntry(pack: Uint8Array, start: number, spend: Spend): { entry: RawEntry; next: number } {
  const header = readEntryHeader(pack, start);
  spend(header.size);
  let at = header.next;
  let base: { baseOffset: number } | { baseSha: string } | null = null;
  if (header.type === OFS_DELTA) {
    const ofs = readOfsBase(pack, at, start);
    base = { baseOffset: ofs.baseOffset };
    at = ofs.next;
  } else if (header.type === REF_DELTA) {
    if (at + 20 > pack.length - 20) throw badPack('a REF_DELTA base id runs into the checksum', at);
    base = { baseSha: bytesToHex(pack.subarray(at, at + 20)) };
    at += 20;
  } else if (TYPES[header.type] === undefined) {
    throw badPack(`unknown entry type ${header.type}`, start);
  }
  const { data, end } = inflateZlibAt(pack, at, header.size);
  if (data.length !== header.size) {
    throw badPack(`an entry inflates to ${data.length} bytes, its header says ${header.size}`, start);
  }
  if (end > pack.length - 20) throw badPack('an entry runs into the checksum', start);
  const type = TYPES[header.type];
  if (base === null && type !== undefined)
    return { entry: { kind: 'whole', offset: start, type, data }, next: end };
  if (base !== null && 'baseOffset' in base) {
    return { entry: { kind: 'ofs', offset: start, baseOffset: base.baseOffset, delta: data }, next: end };
  }
  if (base !== null)
    return { entry: { kind: 'ref', offset: start, baseSha: base.baseSha, delta: data }, next: end };
  throw badPack(`unknown entry type ${header.type}`, start);
}

async function verifyHeader(pack: Uint8Array): Promise<number> {
  if (pack.length < 32) throw badPack('the pack is shorter than its header and checksum', 0);
  if (String.fromCodePoint(...pack.subarray(0, 4)) !== 'PACK')
    throw badPack('the pack does not start with "PACK"', 0);
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw badPack(`unsupported pack version ${version}`, 4);
  const trailer = bytesToHex(pack.subarray(pack.length - 20));
  if (bytesToHex(await sha1Bytes(pack.subarray(0, pack.length - 20))) !== trailer) {
    throw badPack('the pack checksum does not match', pack.length - 20);
  }
  const count = view.getUint32(8);
  if (count > MAX_PACK_OBJECTS) throw badPack(`the pack claims ${count} objects`, 8);
  return count;
}

/**
 * Reads a version 2 (or 3) packfile into whole objects, in pack order, with their ids computed.
 * Resolves OFS_DELTA entries and REF_DELTA entries against objects in the pack or, for a thin
 * pack, through `lookupBase`. Verifies the trailing SHA-1 checksum. Throws an invalid_pack
 * CoreError for anything malformed, including a delta whose base cannot be found.
 */
export async function readPack(pack: Uint8Array, options: ReadPackOptions = {}): Promise<GitObject[]> {
  const count = await verifyHeader(pack);
  const spend = spender(options.maxObjectBytes);
  const entries: RawEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= pack.length - 20) throw badPack(`the pack ends after ${index} of ${count} entries`, offset);
    const { entry, next } = readEntry(pack, offset, spend);
    entries.push(entry);
    offset = next;
  }
  if (offset !== pack.length - 20)
    throw badPack('bytes remain between the last entry and the checksum', offset);
  return resolveEntries(entries, options.lookupBase, spend);
}

async function resolveEntries(
  entries: readonly RawEntry[],
  lookupBase: BaseLookup | undefined,
  spend: Spend,
): Promise<GitObject[]> {
  const byOffset = new Map<number, GitObject>();
  const bySha = new Map<string, GitObject>();
  const record = (offset: number, object: GitObject): void => {
    byOffset.set(offset, object);
    bySha.set(object.sha, object);
  };
  let pending = [...entries];
  while (pending.length > 0) {
    const waiting: RawEntry[] = [];
    for (const entry of pending) {
      const object = await resolveEntry(entry, byOffset, bySha, spend);
      if (object === null) waiting.push(entry);
      else record(entry.offset, object);
    }
    if (waiting.length === pending.length) {
      const resolved = await resolveExternal(waiting, lookupBase, spend);
      for (const [offset, object] of resolved) record(offset, object);
      waiting.splice(0, waiting.length, ...waiting.filter((entry) => !byOffset.has(entry.offset)));
    }
    pending = waiting;
  }
  return entries.map((entry) => byOffset.get(entry.offset)).filter((object) => object !== undefined);
}

async function resolveEntry(
  entry: RawEntry,
  byOffset: ReadonlyMap<number, GitObject>,
  bySha: ReadonlyMap<string, GitObject>,
  spend: Spend,
): Promise<GitObject | null> {
  if (entry.kind === 'whole') return createObject(entry.type, entry.data);
  const base = entry.kind === 'ofs' ? byOffset.get(entry.baseOffset) : bySha.get(entry.baseSha);
  if (base === undefined) return null;
  spend(deltaResultSize(entry.delta));
  return createObject(base.type, applyDelta(base.data, entry.delta));
}

/** Resolves the first REF_DELTA whose base lives outside the pack; fails when none can be. */
async function resolveExternal(
  waiting: readonly RawEntry[],
  lookupBase: BaseLookup | undefined,
  spend: Spend,
): Promise<Map<number, GitObject>> {
  const resolved = new Map<number, GitObject>();
  for (const entry of waiting) {
    if (entry.kind !== 'ref') continue;
    const base = lookupBase === undefined ? null : await lookupBase(entry.baseSha);
    if (base === null) continue;
    spend(base.data.length + deltaResultSize(entry.delta));
    resolved.set(entry.offset, await createObject(base.type, applyDelta(base.data, entry.delta)));
  }
  if (resolved.size === 0) {
    const first = waiting[0];
    const what =
      first?.kind === 'ref'
        ? `base ${first.baseSha}`
        : `base at offset ${first?.kind === 'ofs' ? first.baseOffset : 0}`;
    throw badPack(`a delta's ${what} is not in the pack or the repository`, first?.offset ?? 0);
  }
  return resolved;
}
