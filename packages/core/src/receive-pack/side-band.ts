// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { encodePktLine } from '../pkt-line/encode.ts';
import type { Packet } from '../schemas/packet.ts';

/** The side-band channel that carries protocol data. */
export const BAND_DATA = 1;
/** The side-band channel that carries progress text for the user. */
export const BAND_PROGRESS = 2;
/** The side-band channel that carries a fatal error message. */
export const BAND_ERROR = 3;

/** Most payload bytes after the channel byte in one side-band packet (1000-byte packets). */
export const SIDE_BAND_MAX_PAYLOAD = 995;
/** Most payload bytes after the channel byte in one side-band-64k packet (65520-byte packets). */
export const SIDE_BAND_64K_MAX_PAYLOAD = 65_515;

/** Side-band packets split by channel: the joined data bytes and the progress text. */
export interface Demultiplexed {
  readonly data: Uint8Array;
  readonly progress: string;
}

/**
 * Splits side-band packets (first payload byte = channel) into the data channel's bytes and the
 * progress text, stopping at the first flush. A message on channel 3 throws a remote_error
 * CoreError; an unknown channel or a non-data packet throws malformed_request.
 */
export function demultiplexSideBand(packets: readonly Packet[]): Demultiplexed {
  const data: Uint8Array[] = [];
  // One streaming decoder across packets, so a UTF-8 character split between two is kept whole.
  const progressDecoder = new TextDecoder();
  let progress = '';
  for (const packet of packets) {
    if (packet.type === 'flush') break;
    if (packet.type !== 'data' || packet.payload.length === 0) {
      throw coreError('malformed_request', 'Malformed side-band stream', {
        reason: `unexpected ${packet.type === 'data' ? 'empty' : packet.type} packet in a side-band stream`,
      });
    }
    const band = packet.payload[0];
    const body = packet.payload.subarray(1);
    if (band === BAND_DATA) data.push(body);
    else if (band === BAND_PROGRESS) progress += progressDecoder.decode(body, { stream: true });
    else if (band === BAND_ERROR) {
      const remoteMessage = new TextDecoder().decode(body).replace(/\n$/, '');
      throw coreError('remote_error', `Remote error: ${remoteMessage}`, { remoteMessage });
    } else {
      throw coreError('malformed_request', 'Malformed side-band stream', {
        reason: `unknown side-band channel ${String(band)}`,
      });
    }
  }
  return { data: concatBytes(data), progress: progress + progressDecoder.decode() };
}

/**
 * Wraps bytes for one side-band channel as pkt-lines, split so each packet carries at most
 * `maxPayload` bytes after the channel byte: {@link SIDE_BAND_64K_MAX_PAYLOAD} (65515, the
 * default) for side-band-64k, {@link SIDE_BAND_MAX_PAYLOAD} (995) for side-band.
 */
export function encodeSideBand(
  band: number,
  bytes: Uint8Array,
  maxPayload = SIDE_BAND_64K_MAX_PAYLOAD,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxPayload) {
    const chunk = bytes.subarray(offset, offset + maxPayload);
    parts.push(encodePktLine(concatBytes([Uint8Array.of(band), chunk])));
  }
  return concatBytes(parts);
}
