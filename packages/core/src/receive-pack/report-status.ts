// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { decodePktLines, packetText } from '../pkt-line/decode.ts';
import { encodePktLine, FLUSH_PKT } from '../pkt-line/encode.ts';
import type { Packet } from '../schemas/packet.ts';
import { ReportStatus, type RefStatus } from '../schemas/report-status.ts';
import {
  BAND_DATA,
  demultiplexSideBand,
  encodeSideBand,
  SIDE_BAND_64K_MAX_PAYLOAD,
  SIDE_BAND_MAX_PAYLOAD,
} from './side-band.ts';

/** The side-band variant a push negotiated, or "none". */
export type SideBandMode = 'none' | 'side-band' | 'side-band-64k';

/** How a report-status response is framed. */
export interface ReportStatusFraming {
  /**
   * The side-band capability negotiated: "none" sends the report as bare pkt-lines; "side-band"
   * and "side-band-64k" carry it on channel 1, in packets of at most 1000 and 65520 bytes.
   */
  readonly sideBand: SideBandMode;
}

/**
 * The framing a push's capabilities select. git prefers side-band-64k when a client asks for
 * both, so that wins; otherwise side-band, otherwise none. git receive-pack itself advertises only
 * side-band-64k and answers a plain side-band request with a bare report, so pass the
 * capabilities the answering server honours: the client's when the gateway answers, those
 * receive-pack accepted when parsing a backend's response.
 */
export function reportStatusFraming(capabilities: readonly string[]): ReportStatusFraming {
  if (capabilities.includes('side-band-64k')) return { sideBand: 'side-band-64k' };
  if (capabilities.includes('side-band')) return { sideBand: 'side-band' };
  return { sideBand: 'none' };
}

function malformed(reason: string): Error {
  return coreError('malformed_request', 'Malformed report-status response', { reason });
}

/** Throws remote_error when the response starts with an "ERR" packet. */
function rejectErr(packets: readonly Packet[]): void {
  const first = packets[0];
  const text = first === undefined ? null : packetText(first);
  if (text?.startsWith('ERR ')) {
    const remoteMessage = text.slice(4);
    throw coreError('remote_error', `Remote error: ${remoteMessage}`, { remoteMessage });
  }
}

function parseRefLine(line: string): RefStatus {
  if (line.startsWith('ok ')) return { ref: line.slice(3), status: 'ok' };
  if (line.startsWith('ng ')) {
    const rest = line.slice(3);
    const space = rest.indexOf(' ');
    if (space === -1) return { ref: rest, status: 'ng', reason: 'rejected' };
    return { ref: rest.slice(0, space), status: 'ng', reason: rest.slice(space + 1) };
  }
  throw malformed(`status line ${JSON.stringify(line)} is not "ok <ref>" or "ng <ref> <reason>"`);
}

/**
 * Parses the report-status response of git-receive-pack, demultiplexing side-band framing when
 * it was negotiated. Throws remote_error for an "ERR" packet or a channel-3 message, and
 * malformed_request when the report is not "unpack <result>" followed by ref status lines.
 */
export function parseReportStatus(response: Uint8Array, framing: ReportStatusFraming): ReportStatus {
  const outer = decodePktLines(response);
  rejectErr(outer);
  const packets = framing.sideBand !== 'none' ? decodePktLines(demultiplexSideBand(outer).data) : outer;
  rejectErr(packets);
  const lines: string[] = [];
  for (const packet of packets) {
    const text = packetText(packet);
    if (text === null) break;
    if (!text.startsWith('option ')) lines.push(text);
  }
  const [first, ...rest] = lines;
  if (first?.startsWith('unpack ') !== true) throw malformed('the report does not start with "unpack"');
  const parsed = ReportStatus.safeParse({ unpack: first.slice(7), refs: rest.map(parseRefLine) });
  if (!parsed.success) throw malformed(parsed.error.issues[0]?.message ?? 'invalid report');
  return parsed.data;
}

/**
 * Encodes a report-status response, wrapped for side-band channel 1 and closed with a flush when
 * a side-band was negotiated — split into packets of at most 995 payload bytes for side-band and
 * 65515 for side-band-64k, so no packet exceeds the client's limit. The gateway uses it to refuse pushes in-protocol ("ng <ref> <reason>"), so
 * git prints the reason to the user.
 */
export function encodeReportStatus(status: ReportStatus, framing: ReportStatusFraming): Uint8Array {
  const report = ReportStatus.parse(status);
  const lines = [
    encodePktLine(`unpack ${report.unpack}\n`),
    ...report.refs.map((ref) =>
      encodePktLine(ref.status === 'ok' ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`),
    ),
    FLUSH_PKT,
  ];
  const inner = concatBytes(lines);
  if (framing.sideBand === 'none') return inner;
  const maxPayload = framing.sideBand === 'side-band' ? SIDE_BAND_MAX_PAYLOAD : SIDE_BAND_64K_MAX_PAYLOAD;
  return concatBytes([encodeSideBand(BAND_DATA, inner, maxPayload), FLUSH_PKT]);
}

/** An "ERR <message>" packet: a fatal, user-readable protocol error. */
export function encodeErrPacket(message: string): Uint8Array {
  return encodePktLine(`ERR ${message.replaceAll('\n', ' ')}\n`);
}
