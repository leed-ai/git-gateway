// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { FileMode } from '@leed-ai/git-gateway-contract/schemas/tree-entry';
import { z } from 'zod';

import { bytesToHex, concatBytes, hexToBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { GitTreeEntry } from '../schemas/git-object.ts';

const RESERVED_NAMES = new Set(['.', '..', '.git']);
const decoder = new TextDecoder('utf-8', { fatal: true });

function invalidTree(reason: string, sha: string | null = null): Error {
  return coreError('invalid_object', 'Invalid tree object', { sha, type: 'tree', reason });
}

/** The bytes git sorts a tree entry by: its name, with "/" appended for a subtree. */
function sortKey(entry: GitTreeEntry): Uint8Array {
  return utf8(entry.mode === '040000' ? `${entry.name}/` : entry.name);
}

/** Orders tree entries the way git stores them (byte order, a subtree compared as "<name>/"). */
export function compareTreeEntries(a: GitTreeEntry, b: GitTreeEntry): number {
  const left = sortKey(a);
  const right = sortKey(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** The mode as git writes it in a tree: no leading zero for a directory. */
const storedMode = (mode: FileMode): string => (mode === '040000' ? '40000' : mode);

/**
 * Encodes a tree object from its entries in any order: each entry is "<mode> <name>\0" and the
 * 20-byte id, sorted as git sorts them. Throws an invalid_object CoreError for duplicate names
 * and for the names ".", ".." and ".git" (any case), which `git fsck` rejects.
 */
export function encodeTree(entries: readonly GitTreeEntry[]): Uint8Array {
  const parsed = z.array(GitTreeEntry).parse(entries);
  const names = new Set<string>();
  for (const entry of parsed) {
    if (RESERVED_NAMES.has(entry.name.toLowerCase()))
      throw invalidTree(`reserved entry name "${entry.name}"`);
    if (names.has(entry.name)) throw invalidTree(`duplicate entry name "${entry.name}"`);
    names.add(entry.name);
  }
  const sorted = parsed.toSorted(compareTreeEntries);
  return concatBytes(
    sorted.flatMap((entry) => [utf8(`${storedMode(entry.mode)} ${entry.name}\0`), hexToBytes(entry.sha)]),
  );
}

function readMode(text: string, sha: string | null): FileMode {
  const mode = text === '40000' ? '040000' : text;
  const parsed = FileMode.safeParse(mode);
  if (!parsed.success) throw invalidTree(`unknown mode ${text}`, sha);
  return parsed.data;
}

/**
 * Decodes the content of a tree object into its entries, in stored order. `sha` names the
 * object in error reports. Throws an invalid_object CoreError for truncated content, an unknown
 * mode or a name that is not UTF-8.
 */
export function decodeTree(data: Uint8Array, sha: string | null = null): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw invalidTree(`truncated entry at byte ${offset}`, sha);
    const mode = readMode(String.fromCodePoint(...data.subarray(offset, space)), sha);
    let name: string;
    try {
      name = decoder.decode(data.subarray(space + 1, nul));
    } catch {
      throw invalidTree(`entry name at byte ${offset} is not UTF-8`, sha);
    }
    const entry = GitTreeEntry.safeParse({ name, mode, sha: bytesToHex(data.subarray(nul + 1, nul + 21)) });
    if (!entry.success) throw invalidTree(`bad entry name ${JSON.stringify(name)}`, sha);
    entries.push(entry.data);
    offset = nul + 21;
  }
  return entries;
}
