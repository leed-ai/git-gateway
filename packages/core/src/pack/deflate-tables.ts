// SPDX-License-Identifier: Apache-2.0
import { invalid } from './bit-reader.ts';
import { CODE_LENGTH_ORDER } from './deflate-constants.ts';
import {
  buildHuffmanTable,
  FIXED_DISTANCE_TABLE,
  FIXED_LITERAL_TABLE,
  type HuffmanTable,
} from './huffman.ts';

/** What reading a block's Huffman tables needs from a DEFLATE bit reader. */
export interface InflateBits {
  /** Reads `count` bits (0–16) as an unsigned integer, least significant first. */
  bits(count: number): number;
  /** Decodes one symbol with a canonical Huffman table. */
  decode(table: HuffmanTable): number;
  /** Offset of the next unread byte, for error messages. */
  readonly position: number;
}

/** The literal/length and distance tables of a type-1 (fixed Huffman) block. */
export function readFixedTables(): [HuffmanTable, HuffmanTable] {
  return [FIXED_LITERAL_TABLE, FIXED_DISTANCE_TABLE];
}

/** Reads the code-length-encoded tables at the start of a type-2 (dynamic Huffman) block. */
export function readDynamicTables(reader: InflateBits): [HuffmanTable, HuffmanTable] {
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
