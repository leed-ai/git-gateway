// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { commitHeaderLines, readCommitParents } from '../objects/commit-parents.ts';
import { hashObject } from '../objects/hash-object.ts';
import { applyDelta } from './apply-delta.ts';
import { readEntryStart, type EntryStart } from './pack-entry-header.ts';
import { MAX_PACK_OBJECTS } from './read-pack.ts';
import { StreamInflater } from './stream-inflater.ts';

/** What a scan of a streamed pack found. */
export interface PackScan {
  /**
   * Every commit in the pack, by id, with its parent ids in order — except commits whose header
   * git would read differently from a naive scan (see {@link PackScan.malformed}), which are left
   * out so that an ancestry walk through them finds nothing and answers "unknown".
   */
  readonly commits: ReadonlyMap<string, readonly string[]>;
  /** How many entries the pack holds. */
  readonly objects: number;
  /**
   * Entries whose type could not be told without objects outside the pack (REF_DELTA entries
   * against bases the scan did not keep). They are trees or blobs in every pack git writes, but a
   * caller that fails to find a commit should treat it as unverifiable while this is non-zero.
   */
  readonly unresolved: number;
  /**
   * Commits left out of `commits` because their parents cannot be read the way git reads them:
   * no leading tree line, or a `parent` header anywhere but straight after it.
   */
  readonly malformed: number;
}

/** Options of a {@link PackScanner}. */
export interface PackScannerOptions {
  /**
   * Most bytes of commit objects (and deltas of commits) kept during the scan; a pack needing
   * more throws unsupported_request. Default 32 MiB.
   */
  readonly maxCommitBytes?: number;
}

/** Pack type codes of the kinds an entry resolves to; 0 marks an entry of unknown type. */
const COMMIT = 1;
const UNKNOWN = 0;
const TRAILER_BYTES = 20;

function badPack(reason: string, offset: number): Error {
  return coreError('invalid_pack', 'Invalid pack', { offset, reason });
}

/** The parent ids of a commit object as git reads them, or null when git would read them differently. */
function parentsOf(data: Uint8Array): string[] | null {
  return readCommitParents(commitHeaderLines(new TextDecoder().decode(data)));
}

/** The entry being inflated, and what to do with it once it is. */
type CurrentEntry = EntryStart & {
  readonly inflater: StreamInflater;
  readonly kept: boolean;
};

/**
 * Walks a version 2 or 3 packfile as it streams past, chunk by chunk, and collects the commits it
 * holds with their parents — what a gateway needs to prove a pushed update is a fast-forward
 * without buffering the pack. Every entry is inflated to find where it ends, but only commits
 * (and deltas whose base is a commit) are kept; trees and blobs pass through DEFLATE's 32 KiB
 * window. The trailing checksum is not verified (the storage host verifies the pack it receives).
 * Throws an invalid_pack CoreError for a malformed pack.
 */
export class PackScanner {
  readonly #maxCommitBytes: number;
  /** Type code of every entry by its offset, for OFS_DELTA bases. */
  readonly #types = new Map<number, number>();
  readonly #commitByOffset = new Map<number, Uint8Array>();
  readonly #commitBySha = new Map<string, Uint8Array>();
  readonly #commits = new Map<string, readonly string[]>();
  #buffer: Uint8Array = new Uint8Array(0);
  /** Offset in the pack of `#buffer[0]`. */
  #offset = 0;
  #count = -1;
  #seen = 0;
  #keptBytes = 0;
  #unresolved = 0;
  #malformed = 0;
  #current: CurrentEntry | null = null;
  #done = false;

  constructor(options: PackScannerOptions = {}) {
    this.#maxCommitBytes = options.maxCommitBytes ?? 32 * 1024 * 1024;
  }

  /** Feeds the next chunk of the pack. */
  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    if (this.#done) throw badPack('bytes follow the pack checksum', this.#offset);
    this.#buffer = this.#buffer.length === 0 ? chunk : concatBytes([this.#buffer, chunk]);
    while (await this.#advance());
  }

  /** The scan result; throws invalid_pack when the pack ended early. */
  finish(): PackScan {
    if (!this.#done) throw badPack('the pack ends before its checksum', this.#offset + this.#buffer.length);
    return {
      commits: this.#commits,
      objects: this.#count,
      unresolved: this.#unresolved,
      malformed: this.#malformed,
    };
  }

  /** Makes one step of progress with the buffered bytes; false when it needs more. */
  async #advance(): Promise<boolean> {
    if (this.#done) {
      if (this.#buffer.length > 0) throw badPack('bytes follow the pack checksum', this.#offset);
      return false;
    }
    if (this.#count === -1) return this.#readHeader();
    if (this.#current !== null) return this.#inflate(this.#current);
    if (this.#seen === this.#count) return this.#readTrailer();
    return this.#startEntry();
  }

  #consume(count: number): void {
    this.#buffer = this.#buffer.subarray(count);
    this.#offset += count;
  }

  #readHeader(): boolean {
    if (this.#buffer.length < 12) return false;
    if (String.fromCodePoint(...this.#buffer.subarray(0, 4)) !== 'PACK')
      throw badPack('the pack does not start with "PACK"', 0);
    const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 12);
    const version = view.getUint32(4);
    if (version !== 2 && version !== 3) throw badPack(`unsupported pack version ${version}`, 4);
    const count = view.getUint32(8);
    if (count > MAX_PACK_OBJECTS) throw badPack(`the pack claims ${count} objects`, 8);
    this.#count = count;
    this.#consume(12);
    return true;
  }

  #readTrailer(): boolean {
    if (this.#buffer.length < TRAILER_BYTES) return false;
    this.#consume(TRAILER_BYTES);
    this.#done = true;
    return true;
  }

  #startEntry(): boolean {
    const start = readEntryStart(this.#buffer, this.#offset);
    if (start === null) return false;
    const baseType = this.#baseTypeOf(start);
    const keepsCommit =
      start.type === COMMIT ||
      (start.kind !== 'whole' && baseType === COMMIT && this.#baseData(start) !== null);
    if (keepsCommit) {
      if (this.#keptBytes + start.size > this.#maxCommitBytes) {
        throw coreError('unsupported_request', 'The pushed commits are too large to scan', {
          feature: `more than ${this.#maxCommitBytes} bytes of commits in one push`,
        });
      }
      this.#keptBytes += start.size;
    }
    const inflater = new StreamInflater(keepsCommit ? { keep: start.size } : {});
    this.#current = { ...start, inflater, kept: keepsCommit };
    this.#consume(start.headerLength);
    return true;
  }

  async #inflate(entry: CurrentEntry): Promise<boolean> {
    if (this.#buffer.length === 0) return false;
    const fed = this.#buffer.length;
    const rest = entry.inflater.push(this.#buffer);
    if (rest === null) {
      this.#offset += fed;
      this.#buffer = new Uint8Array(0);
      return false;
    }
    this.#offset += fed - rest.length;
    this.#buffer = rest;
    if (entry.inflater.outputLength !== entry.size) {
      throw badPack(
        `an entry inflates to ${entry.inflater.outputLength} bytes, its header says ${entry.size}`,
        entry.offset,
      );
    }
    this.#current = null;
    this.#seen += 1;
    await this.#finishEntry(entry);
    return true;
  }

  async #finishEntry(entry: CurrentEntry): Promise<void> {
    if (!entry.kept) {
      this.#types.set(entry.offset, entry.kind === 'whole' ? entry.type : this.#baseTypeOf(entry));
      if (entry.kind === 'ref' || this.#types.get(entry.offset) === UNKNOWN) this.#unresolved += 1;
      return;
    }
    const data =
      entry.kind === 'whole'
        ? entry.inflater.result()
        : applyDelta(this.#baseData(entry) ?? new Uint8Array(0), entry.inflater.result());
    const sha = await hashObject('commit', data);
    this.#types.set(entry.offset, COMMIT);
    this.#commitByOffset.set(entry.offset, data);
    this.#commitBySha.set(sha, data);
    const parents = parentsOf(data);
    if (parents === null) this.#malformed += 1;
    else this.#commits.set(sha, parents);
  }

  /** The type code an entry resolves to before it is inflated (its base's, for a delta). */
  #baseTypeOf(start: EntryStart): number {
    if (start.kind === 'whole') return start.type;
    if (start.kind === 'ofs') {
      const type = this.#types.get(start.baseOffset);
      if (type === undefined)
        throw badPack(`no entry starts at OFS_DELTA base offset ${start.baseOffset}`, start.offset);
      return type;
    }
    return this.#commitBySha.has(start.baseSha) ? COMMIT : UNKNOWN;
  }

  #baseData(start: EntryStart): Uint8Array | null {
    if (start.kind === 'ofs') return this.#commitByOffset.get(start.baseOffset) ?? null;
    if (start.kind === 'ref') return this.#commitBySha.get(start.baseSha) ?? null;
    return null;
  }
}
