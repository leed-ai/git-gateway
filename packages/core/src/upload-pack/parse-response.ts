// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { readLengthHeader, truncatedPacket } from '../pkt-line/length-header.ts';
import { BAND_DATA, BAND_ERROR, BAND_PROGRESS } from '../receive-pack/side-band.ts';
import { UploadPackResponse } from '../schemas/upload-pack.ts';

const SHALLOW = /^(shallow|unshallow) ([0-9a-f]{40})$/;
const ACK = /^ACK ([0-9a-f]{40})(?: \S+)?$/;
const decoder = new TextDecoder();

function malformed(reason: string): Error {
  return coreError('malformed_request', 'Malformed upload-pack response', { reason });
}

/** Reads one pkt-line at `offset`: its payload (null for flush) and where the next starts. */
function packetAt(bytes: Uint8Array, offset: number): { payload: Uint8Array | null; next: number } {
  if (bytes.length - offset < 4) throw truncatedPacket(offset, 4 - (bytes.length - offset));
  const header = readLengthHeader(bytes.subarray(offset, offset + 4), offset);
  if (header.kind === 'special') return { payload: null, next: offset + 4 };
  const end = offset + 4 + header.payloadLength;
  if (end > bytes.length) throw truncatedPacket(offset, end - bytes.length);
  return { payload: bytes.subarray(offset + 4, end), next: end };
}

const text = (payload: Uint8Array): string => decoder.decode(payload).replace(/\n$/, '');

/** Options of {@link parseUploadPackResponse}. */
export interface UploadPackResponseOptions {
  /** The request asked for a deepen, so the answer starts with shallow lines and a flush. */
  readonly deepen: boolean;
  /** The request asked for side-band or side-band-64k, so the pack is multiplexed. */
  readonly sideBand: boolean;
}

/**
 * Parses the answer to a stateless protocol v0/v1 upload-pack request that ended in "done":
 * shallow/unshallow lines and a flush when a deepen was requested, the "NAK" or "ACK" lines,
 * then the pack — demultiplexed from side-band channel 1 when side-band was negotiated, raw
 * otherwise. Throws remote_error for "ERR" lines or channel-3 messages, malformed_request for
 * anything else unexpected.
 */
export function parseUploadPackResponse(
  bytes: Uint8Array,
  options: UploadPackResponseOptions,
): UploadPackResponse {
  const shallow: string[] = [];
  const acknowledged: string[] = [];
  let offset = 0;
  if (options.deepen) {
    for (;;) {
      const { payload, next } = packetAt(bytes, offset);
      offset = next;
      if (payload === null) break;
      const match = SHALLOW.exec(text(payload));
      if (match === null) throwRemoteOr(text(payload), 'expected shallow lines before the flush');
      if (match?.[1] === 'shallow' && match[2] !== undefined) shallow.push(match[2]);
    }
  }
  for (;;) {
    if (offset >= bytes.length)
      return UploadPackResponse.parse({ shallow, acknowledged, pack: new Uint8Array(0), progress: '' });
    const { payload, next } = packetAt(bytes, offset);
    if (payload === null) throw malformed('flush before the acknowledgements');
    const line = text(payload);
    if (line === 'NAK') {
      offset = next;
      break;
    }
    const ack = ACK.exec(line);
    if (ack === null) throwRemoteOr(line, `expected NAK or ACK, got ${JSON.stringify(line.slice(0, 80))}`);
    acknowledged.push(ack?.[1] ?? '');
    offset = next;
    if (!line.includes(' ', 44)) break;
  }
  if (!options.sideBand) {
    return UploadPackResponse.parse({ shallow, acknowledged, pack: bytes.slice(offset), progress: '' });
  }
  return UploadPackResponse.parse({ shallow, acknowledged, ...demultiplex(bytes, offset) });
}

function throwRemoteOr(line: string, reason: string): void {
  if (line.startsWith('ERR ')) {
    const remoteMessage = line.slice(4);
    throw coreError('remote_error', `Remote error: ${remoteMessage}`, { remoteMessage });
  }
  throw malformed(reason);
}

function demultiplex(bytes: Uint8Array, start: number): { pack: Uint8Array; progress: string } {
  const pack: Uint8Array[] = [];
  let progress = '';
  let offset = start;
  while (offset < bytes.length) {
    const { payload, next } = packetAt(bytes, offset);
    offset = next;
    if (payload === null) break;
    const band = payload[0];
    const body = payload.subarray(1);
    if (band === BAND_DATA) pack.push(body);
    else if (band === BAND_PROGRESS) progress += decoder.decode(body);
    else if (band === BAND_ERROR) {
      const remoteMessage = text(body);
      throw coreError('remote_error', `Remote error: ${remoteMessage}`, { remoteMessage });
    } else throw malformed(`unknown side-band channel ${String(band)}`);
  }
  return { pack: concatBytes(pack), progress };
}
