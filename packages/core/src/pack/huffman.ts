// SPDX-License-Identifier: Apache-2.0

/** A canonical Huffman decoding table (RFC 1951 §3.2.2): code counts per length and symbols in code order. */
export interface HuffmanTable {
  /** counts[n] is how many codes are n bits long; counts[0] is unused. */
  readonly counts: Uint16Array;
  /** Symbols ordered by code: shorter codes first, then by symbol value. */
  readonly symbols: Uint16Array;
}

/** The longest Huffman code DEFLATE uses. */
export const MAX_CODE_BITS = 15;

/** Builds the decoding table for a list of code lengths, one per symbol (0 = symbol unused). */
export function buildHuffmanTable(lengths: ArrayLike<number>): HuffmanTable {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol] ?? 0;
    counts[length] = (counts[length] ?? 0) + 1;
  }
  counts[0] = 0;
  const offsets = new Uint16Array(MAX_CODE_BITS + 2);
  for (let bits = 1; bits <= MAX_CODE_BITS; bits += 1)
    offsets[bits + 1] = (offsets[bits] ?? 0) + (counts[bits] ?? 0);
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol] ?? 0;
    if (length !== 0) {
      symbols[offsets[length] ?? 0] = symbol;
      offsets[length] = (offsets[length] ?? 0) + 1;
    }
  }
  return { counts, symbols };
}

const fixedLiteralLengths = new Uint8Array(288);
fixedLiteralLengths.fill(8, 0, 144);
fixedLiteralLengths.fill(9, 144, 256);
fixedLiteralLengths.fill(7, 256, 280);
fixedLiteralLengths.fill(8, 280, 288);

/** The fixed literal/length table of a type-1 block. */
export const FIXED_LITERAL_TABLE: HuffmanTable = buildHuffmanTable(fixedLiteralLengths);
/** The fixed distance table of a type-1 block. */
export const FIXED_DISTANCE_TABLE: HuffmanTable = buildHuffmanTable(new Uint8Array(30).fill(5));
