// SPDX-License-Identifier: Apache-2.0
import { coreError } from '../core-error.ts';
import { MAX_PKT_PAYLOAD, type Packet } from '../schemas/packet.ts';

const HEX4 = /^[0-9a-fA-F]{4}$/;
const SPECIAL_BY_LENGTH: Readonly<Record<number, Packet>> = {
  0: { type: 'flush' },
  1: { type: 'delim' },
  2: { type: 'response-end' },
};

/** What a 4-byte length header announces: a special packet, or a data packet of `payloadLength` bytes. */
export type LengthHeader =
  | { readonly kind: 'special'; readonly packet: Packet }
  | { readonly kind: 'data'; readonly payloadLength: number };

/**
 * Reads the 4-byte pkt-line length header at the start of `header`. `offset` is where the
 * header sits in the whole input, for error reports.
 */
export function readLengthHeader(header: Uint8Array, offset: number): LengthHeader {
  const text = String.fromCodePoint(...header.subarray(0, 4));
  if (!HEX4.test(text)) {
    throw coreError('malformed_pkt_line', 'Bad pkt-line length header', {
      offset,
      reason: `length header ${JSON.stringify(text)} is not four hex digits`,
    });
  }
  const length = Number.parseInt(text, 16);
  const special = SPECIAL_BY_LENGTH[length];
  if (special !== undefined) return { kind: 'special', packet: special };
  if (length < 4 || length - 4 > MAX_PKT_PAYLOAD) {
    throw coreError('malformed_pkt_line', 'Bad pkt-line length', {
      offset,
      reason: `length ${length} is outside 4–${MAX_PKT_PAYLOAD + 4}`,
    });
  }
  return { kind: 'data', payloadLength: length - 4 };
}

/** The error for input that ends inside a packet. */
export function truncatedPacket(offset: number, needed: number): Error {
  return coreError('malformed_pkt_line', 'Input ends inside a pkt-line', {
    offset,
    reason: `input ends ${needed} byte(s) short of a complete packet`,
  });
}
