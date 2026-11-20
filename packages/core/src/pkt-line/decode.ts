// SPDX-License-Identifier: Apache-2.0
import type { Packet } from '../schemas/packet.ts';
import { readLengthHeader, truncatedPacket } from './length-header.ts';

/**
 * Decodes a complete buffer of pkt-lines. Throws a malformed_pkt_line CoreError on a bad header
 * or when the buffer ends inside a packet. Payloads are views into `bytes`, not copies.
 */
export function decodePktLines(bytes: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw truncatedPacket(offset, 4 - (bytes.length - offset));
    const header = readLengthHeader(bytes.subarray(offset, offset + 4), offset);
    if (header.kind === 'special') {
      packets.push(header.packet);
      offset += 4;
      continue;
    }
    const end = offset + 4 + header.payloadLength;
    if (end > bytes.length) throw truncatedPacket(offset, end - bytes.length);
    packets.push({ type: 'data', payload: bytes.subarray(offset + 4, end) });
    offset = end;
  }
  return packets;
}

const decoder = new TextDecoder();

/** A data packet's payload as text without one trailing "\n", or null for a special packet. */
export function packetText(packet: Packet): string | null {
  if (packet.type !== 'data') return null;
  const text = decoder.decode(packet.payload);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
