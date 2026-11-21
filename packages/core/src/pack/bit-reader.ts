// SPDX-License-Identifier: Apache-2.0
import { coreError } from '../core-error.ts';
import { MAX_CODE_BITS, type HuffmanTable } from './huffman.ts';

/** Reads DEFLATE's least-significant-bit-first bit stream from a byte array. */
export class BitReader {
  readonly #bytes: Uint8Array;
  #position: number;
  #bitBuffer = 0;
  #bitCount = 0;

  constructor(bytes: Uint8Array, position: number) {
    this.#bytes = bytes;
    this.#position = position;
  }

  /** The offset of the next unread byte (after {@link alignToByte}, the exact stream position). */
  get position(): number {
    return this.#position;
  }

  /** Reads `count` bits (0–16) as an unsigned integer, least significant first. */
  bits(count: number): number {
    while (this.#bitCount < count) {
      const byte = this.#bytes[this.#position];
      if (byte === undefined) throw truncated(this.#position);
      this.#bitBuffer |= byte << this.#bitCount;
      this.#position += 1;
      this.#bitCount += 8;
    }
    const value = this.#bitBuffer & ((1 << count) - 1);
    this.#bitBuffer >>>= count;
    this.#bitCount -= count;
    return value;
  }

  /** Drops the bits left in the current byte, so reading continues at a byte boundary. */
  alignToByte(): void {
    this.#bitBuffer = 0;
    this.#bitCount = 0;
  }

  /** Reads `count` whole bytes; call {@link alignToByte} first. */
  bytes(count: number): Uint8Array {
    const end = this.#position + count;
    if (end > this.#bytes.length) throw truncated(this.#bytes.length);
    const out = this.#bytes.subarray(this.#position, end);
    this.#position = end;
    return out;
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
    throw invalid('no Huffman code matches the input', this.#position);
  }
}

/** The error for a zlib stream that ends early. */
export function truncated(offset: number): Error {
  return coreError('invalid_pack', 'Truncated zlib stream', {
    offset,
    reason: 'the compressed data ends before the zlib stream is complete',
  });
}

/** The error for zlib data that does not decode; `offset` is where decoding stopped. */
export function invalid(reason: string, offset = 0): Error {
  return coreError('invalid_pack', 'Invalid zlib stream', { offset, reason });
}
