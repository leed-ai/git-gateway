// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';

import { concatBytes } from '../bytes.ts';
import { MAX_PKT_PAYLOAD, Packet } from '../schemas/packet.ts';

const SPECIAL = { flush: '0000', delim: '0001', 'response-end': '0002' } as const;

/** The flush packet, "0000". */
export const FLUSH_PKT: Uint8Array = utf8(SPECIAL.flush);
/** The delim packet, "0001". */
export const DELIM_PKT: Uint8Array = utf8(SPECIAL.delim);
/** The response-end packet, "0002". */
export const RESPONSE_END_PKT: Uint8Array = utf8(SPECIAL['response-end']);

/**
 * Frames a payload as one data pkt-line: four lowercase hex digits giving the total length
 * (payload plus the header itself), then the payload. Strings are written as UTF-8 exactly as
 * given; text lines conventionally end with "\n", which the caller includes.
 */
export function encodePktLine(payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === 'string' ? utf8(payload) : payload;
  if (bytes.length > MAX_PKT_PAYLOAD) {
    throw new RangeError(`pkt-line payload of ${bytes.length} bytes exceeds ${MAX_PKT_PAYLOAD}`);
  }
  const header = utf8((bytes.length + 4).toString(16).padStart(4, '0'));
  return concatBytes([header, bytes]);
}

/** Encodes one packet. */
export function encodePacket(packet: Packet): Uint8Array {
  const parsed = Packet.parse(packet);
  return parsed.type === 'data' ? encodePktLine(parsed.payload) : utf8(SPECIAL[parsed.type]);
}

/** Encodes several packets, one after another. */
export function encodePackets(packets: readonly Packet[]): Uint8Array {
  return concatBytes(packets.map(encodePacket));
}
