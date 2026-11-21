// SPDX-License-Identifier: Apache-2.0
import { BitReader, invalid } from './bit-reader.ts';
import { DIST_BASE, DIST_EXTRA, LENGTH_BASE, LENGTH_EXTRA } from './deflate-constants.ts';
import { readDynamicTables } from './deflate-tables.ts';
import { FIXED_DISTANCE_TABLE, FIXED_LITERAL_TABLE, type HuffmanTable } from './huffman.ts';

/** One inflated zlib stream and where it ended. */
export interface InflatedStream {
  /** The decompressed bytes. */
  readonly data: Uint8Array;
  /** Offset of the first byte after the stream (after its Adler-32 trailer). */
  readonly end: number;
}

/** A growable output buffer that can copy back-references from itself. */
class Output {
  #bytes: Uint8Array;
  length = 0;

  constructor(expected: number) {
    this.#bytes = new Uint8Array(Math.max(expected, 64));
  }

  #reserve(extra: number): void {
    if (this.length + extra <= this.#bytes.length) return;
    const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.length + extra));
    grown.set(this.#bytes.subarray(0, this.length));
    this.#bytes = grown;
  }

  push(byte: number): void {
    this.#reserve(1);
    this.#bytes[this.length] = byte;
    this.length += 1;
  }

  append(bytes: Uint8Array): void {
    this.#reserve(bytes.length);
    this.#bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  copy(distance: number, count: number, offset: number): void {
    if (distance > this.length)
      throw invalid(`back-reference distance ${distance} exceeds the output`, offset);
    this.#reserve(count);
    for (let index = 0; index < count; index += 1) {
      this.#bytes[this.length] = this.#bytes[this.length - distance] ?? 0;
      this.length += 1;
    }
  }

  result(): Uint8Array {
    return this.#bytes.slice(0, this.length);
  }
}

function inflateBlock(
  reader: BitReader,
  output: Output,
  literals: HuffmanTable,
  distances: HuffmanTable,
): void {
  for (;;) {
    const symbol = reader.decode(literals);
    if (symbol < 256) {
      output.push(symbol);
      continue;
    }
    if (symbol === 256) return;
    const lengthIndex = symbol - 257;
    const base = LENGTH_BASE[lengthIndex];
    if (base === undefined) throw invalid(`invalid length symbol ${symbol}`, reader.position);
    const length = base + reader.bits(LENGTH_EXTRA[lengthIndex] ?? 0);
    const distanceSymbol = reader.decode(distances);
    const distanceBase = DIST_BASE[distanceSymbol];
    if (distanceBase === undefined)
      throw invalid(`invalid distance symbol ${distanceSymbol}`, reader.position);
    output.copy(distanceBase + reader.bits(DIST_EXTRA[distanceSymbol] ?? 0), length, reader.position);
  }
}

function inflateStored(reader: BitReader, output: Output): void {
  reader.alignToByte();
  const header = reader.bytes(4);
  const length = (header[0] ?? 0) | ((header[1] ?? 0) << 8);
  const complement = (header[2] ?? 0) | ((header[3] ?? 0) << 8);
  if ((length ^ 0xffff) !== complement) throw invalid('stored block length check failed', reader.position);
  output.append(reader.bytes(length));
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let offset = 0; offset < bytes.length; offset += 5552) {
    const end = Math.min(offset + 5552, bytes.length);
    for (let index = offset; index < end; index += 1) {
      a += bytes[index] ?? 0;
      b += a;
    }
    a %= 65_521;
    b %= 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflates the zlib stream (RFC 1950 around RFC 1951 DEFLATE) that starts at `start` in `bytes`,
 * and reports where it ends. Packfiles store entries back to back with no length prefix, so the
 * end of each stream is only known by decoding it — which the platform's DecompressionStream
 * cannot report; this decoder can. `expectedSize` presizes the output. The Adler-32 trailer is
 * verified. Throws an invalid_pack CoreError for truncated or corrupt data.
 */
export function inflateZlibAt(bytes: Uint8Array, start: number, expectedSize = 0): InflatedStream {
  const cmf = bytes[start];
  const flg = bytes[start + 1];
  if (cmf === undefined || flg === undefined) throw invalid('missing zlib header', start);
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw invalid('bad zlib header', start);
  if ((flg & 0x20) !== 0) throw invalid('preset dictionaries are not supported', start);
  const reader = new BitReader(bytes, start + 2);
  const output = new Output(expectedSize);
  let final = 0;
  while (final === 0) {
    final = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) inflateStored(reader, output);
    else if (type === 1) inflateBlock(reader, output, FIXED_LITERAL_TABLE, FIXED_DISTANCE_TABLE);
    else if (type === 2) inflateBlock(reader, output, ...readDynamicTables(reader));
    else throw invalid('reserved block type 3', reader.position);
  }
  reader.alignToByte();
  const trailer = reader.bytes(4);
  const data = output.result();
  const expected =
    (((trailer[0] ?? 0) << 24) | ((trailer[1] ?? 0) << 16) | ((trailer[2] ?? 0) << 8) | (trailer[3] ?? 0)) >>>
    0;
  if (adler32(data) !== expected) throw invalid('Adler-32 checksum mismatch', reader.position);
  return { data, end: reader.position };
}
