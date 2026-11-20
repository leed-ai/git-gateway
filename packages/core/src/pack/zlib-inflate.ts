// SPDX-License-Identifier: Apache-2.0
import { BitReader, invalid } from './bit-reader.ts';
import {
  buildHuffmanTable,
  FIXED_DISTANCE_TABLE,
  FIXED_LITERAL_TABLE,
  type HuffmanTable,
} from './huffman.ts';

/** One inflated zlib stream and where it ended. */
export interface InflatedStream {
  /** The decompressed bytes. */
  readonly data: Uint8Array;
  /** Offset of the first byte after the stream (after its Adler-32 trailer). */
  readonly end: number;
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
  227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** The order code-length code lengths are sent in (RFC 1951 §3.2.7). */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

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

function readDynamicTables(reader: BitReader): [HuffmanTable, HuffmanTable] {
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;
  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengthLengths[CODE_LENGTH_ORDER[index] ?? 0] = reader.bits(3);
  }
  const codeLengthTable = buildHuffmanTable(codeLengthLengths);
  const lengths = new Uint8Array(literalCount + distanceCount);
  let index = 0;
  while (index < lengths.length) {
    const symbol = reader.decode(codeLengthTable);
    if (symbol < 16) {
      lengths[index] = symbol;
      index += 1;
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      if (index === 0) throw invalid('a length repeat has no previous length', reader.position);
      value = lengths[index - 1] ?? 0;
      repeat = 3 + reader.bits(2);
    } else repeat = symbol === 17 ? 3 + reader.bits(3) : 11 + reader.bits(7);
    if (index + repeat > lengths.length) throw invalid('code lengths overflow the table', reader.position);
    lengths.fill(value, index, index + repeat);
    index += repeat;
  }
  return [
    buildHuffmanTable(lengths.subarray(0, literalCount)),
    buildHuffmanTable(lengths.subarray(literalCount)),
  ];
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
