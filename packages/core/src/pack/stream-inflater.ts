// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { invalid } from './bit-reader.ts';
import { readDynamicTables, readFixedTables, type InflateBits } from './deflate-tables.ts';
import { MAX_CODE_BITS, type HuffmanTable } from './huffman.ts';
import { DIST_BASE, DIST_EXTRA, LENGTH_BASE, LENGTH_EXTRA } from './deflate-constants.ts';
import { InflateOutput } from './inflate-output.ts';

/** Options of a {@link StreamInflater}. */
export interface StreamInflaterOptions {
  /**
   * Keep the decompressed bytes for {@link StreamInflater.result}, at most this many. Absent: the
   * output is decoded (it must be, to find where the stream ends) but only DEFLATE's 32 KiB window
   * is kept, so a stream of any size inflates in constant memory.
   */
  readonly keep?: number;
}

/** Thrown inside the decoder when the input runs out; the decoder rewinds to its last checkpoint. */
const NEED_MORE: unique symbol = Symbol('need more input');

type State = 'header' | 'block' | 'codes' | 'stored' | 'trailer' | 'done';
/** What the decoder does after a unit: go on, wait for the next chunk, or stop at the stream end. */
type Step = 'continue' | 'wait' | 'end';

/**
 * Inflates one zlib stream (RFC 1950 around RFC 1951 DEFLATE) fed in chunks of any size, and
 * reports where it ends. Packfiles store entries back to back with no length prefix, so a
 * streamed pack can only be walked by decoding every entry; this decoder suspends whenever a
 * chunk runs out and resumes with the next, keeping only the bytes of a partly read symbol or
 * block header between chunks. The Adler-32 trailer is verified. Throws an invalid_pack
 * CoreError for corrupt data.
 */
export class StreamInflater implements InflateBits {
  readonly #output: InflateOutput;
  #input: Uint8Array = new Uint8Array(0);
  #position = 0;
  #bitBuffer = 0;
  #bitCount = 0;
  #state: State = 'header';
  #final = false;
  #storedLeft = 0;
  #literals: HuffmanTable | null = null;
  #distances: HuffmanTable | null = null;
  /** Bytes of input consumed by earlier, discarded buffers (for error offsets). */
  #consumedBefore = 0;

  constructor(options: StreamInflaterOptions = {}) {
    this.#output = new InflateOutput(options.keep);
  }

  /** True once the stream's trailer has been read and verified. */
  get done(): boolean {
    return this.#state === 'done';
  }

  /** How many bytes the stream has decompressed to so far. */
  get outputLength(): number {
    return this.#output.length;
  }

  /** The decompressed bytes (only when constructed with `keep`). */
  result(): Uint8Array {
    return this.#output.result();
  }

  /**
   * Feeds the next chunk. Returns null while the stream needs more input; once it ends, returns
   * the bytes that followed it (from this chunk, possibly empty). Feeding after the end throws.
   */
  push(chunk: Uint8Array): Uint8Array | null {
    if (this.#state === 'done') throw new Error('StreamInflater: the stream has already ended');
    const unread = this.#input.subarray(this.#position);
    this.#consumedBefore += this.#position;
    this.#input = unread.length === 0 ? chunk : concatBytes([unread, chunk]);
    this.#position = 0;
    this.#run();
    return this.done ? this.#input.subarray(this.#position) : null;
  }

  /** Reads `count` bits (0–16), least significant first; throws NEED_MORE when the input runs out. */
  bits(count: number): number {
    while (this.#bitCount < count) {
      const byte = this.#input[this.#position];
      if (byte === undefined) throw NEED_MORE;
      this.#bitBuffer |= byte << this.#bitCount;
      this.#position += 1;
      this.#bitCount += 8;
    }
    const value = this.#bitBuffer & ((1 << count) - 1);
    this.#bitBuffer >>>= count;
    this.#bitCount -= count;
    return value;
  }

  /** Decodes one symbol with a canonical Huffman table. */
  decode(table: HuffmanTable): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
      code |= this.bits(1);
      const count = table.counts[length] ?? 0;
      if (code - first < count) return table.symbols[index + code - first] ?? 0;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw invalid('no Huffman code matches the input', this.position);
  }

  /** Offset in the whole input of the next unread byte, for error messages. */
  get position(): number {
    return this.#consumedBefore + this.#position;
  }

  #run(): void {
    for (;;) {
      if (this.#position >= 65_536) this.#discardRead();
      const position = this.#position;
      const bitBuffer = this.#bitBuffer;
      const bitCount = this.#bitCount;
      let next: Step;
      try {
        next = this.#step();
      } catch (thrown) {
        if (thrown !== NEED_MORE) throw thrown;
        this.#position = position;
        this.#bitBuffer = bitBuffer;
        this.#bitCount = bitCount;
        return;
      }
      if (next !== 'continue') return;
    }
  }

  /** Drops the input already decoded, so a long chunk is not kept whole while it is worked through. */
  #discardRead(): void {
    this.#consumedBefore += this.#position;
    this.#input = this.#input.subarray(this.#position);
    this.#position = 0;
  }

  /**
   * Advances by one atomic unit: the zlib header, a block header with its tables, one symbol, the
   * stored bytes available, or the trailer. A unit either completes or throws NEED_MORE having
   * changed nothing but the read position, which the caller rewinds.
   */
  #step(): Step {
    switch (this.#state) {
      case 'header':
        this.#readHeader();
        return 'continue';
      case 'block':
        this.#readBlockHeader();
        return 'continue';
      case 'codes':
        this.#decodeSymbol();
        return 'continue';
      case 'stored':
        return this.#copyStored();
      case 'trailer':
        this.#readTrailer();
        return 'end';
      default:
        return 'end';
    }
  }

  #byte(): number {
    const byte = this.#input[this.#position];
    if (byte === undefined) throw NEED_MORE;
    this.#position += 1;
    return byte;
  }

  #readHeader(): void {
    const cmf = this.#byte();
    const flg = this.#byte();
    if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw invalid('bad zlib header', this.position);
    if ((flg & 0x20) !== 0) throw invalid('preset dictionaries are not supported', this.position);
    this.#state = 'block';
  }

  #readBlockHeader(): void {
    const final = this.bits(1) === 1;
    const type = this.bits(2);
    if (type === 0) {
      this.#bitBuffer = 0;
      this.#bitCount = 0;
      const length = this.#byte() | (this.#byte() << 8);
      const complement = this.#byte() | (this.#byte() << 8);
      if ((length ^ 0xffff) !== complement) throw invalid('stored block length check failed', this.position);
      this.#storedLeft = length;
      this.#state = 'stored';
    } else if (type === 1 || type === 2) {
      [this.#literals, this.#distances] = type === 1 ? readFixedTables() : readDynamicTables(this);
      this.#state = 'codes';
    } else throw invalid('reserved block type 3', this.position);
    this.#final = final;
  }

  #endBlock(): void {
    this.#state = this.#final ? 'trailer' : 'block';
  }

  /** Copies the stored-block bytes at hand; "wait" when the block continues in the next chunk. */
  #copyStored(): Step {
    const available = Math.min(this.#storedLeft, this.#input.length - this.#position);
    if (available > 0) {
      this.#output.append(this.#input.subarray(this.#position, this.#position + available), this.position);
      this.#position += available;
      this.#storedLeft -= available;
    }
    if (this.#storedLeft > 0) return 'wait';
    this.#endBlock();
    return 'continue';
  }

  /** Decodes one literal, end-of-block or length/distance pair. */
  #decodeSymbol(): void {
    const literals = this.#literals;
    const distances = this.#distances;
    if (literals === null || distances === null) throw invalid('missing Huffman tables', this.position);
    const symbol = this.decode(literals);
    if (symbol < 256) {
      this.#output.push(symbol);
      return;
    }
    if (symbol === 256) {
      this.#endBlock();
      return;
    }
    const lengthIndex = symbol - 257;
    const base = LENGTH_BASE[lengthIndex];
    if (base === undefined) throw invalid(`invalid length symbol ${symbol}`, this.position);
    const length = base + this.bits(LENGTH_EXTRA[lengthIndex] ?? 0);
    const distanceSymbol = this.decode(distances);
    const distanceBase = DIST_BASE[distanceSymbol];
    if (distanceBase === undefined) throw invalid(`invalid distance symbol ${distanceSymbol}`, this.position);
    this.#output.copy(distanceBase + this.bits(DIST_EXTRA[distanceSymbol] ?? 0), length, this.position);
  }

  #readTrailer(): void {
    this.#bitBuffer = 0;
    this.#bitCount = 0;
    const expected = ((this.#byte() << 24) | (this.#byte() << 16) | (this.#byte() << 8) | this.#byte()) >>> 0;
    if (this.#output.adler32() !== expected) throw invalid('Adler-32 checksum mismatch', this.position);
    this.#state = 'done';
  }
}
