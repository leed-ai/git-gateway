// SPDX-License-Identifier: Apache-2.0
import { coreError } from '../core-error.ts';
import { packetText } from '../pkt-line/decode.ts';
import { PktLineReader } from '../pkt-line/pkt-line-reader.ts';
import type { Packet } from '../schemas/packet.ts';
import { ReceivePackCommand, ReceivePackRequest } from '../schemas/receive-pack.ts';

/** A parsed request head and the request body to forward. */
export interface ParsedReceivePack {
  /** The update commands, capabilities, push options and shallow lines. */
  readonly request: ReceivePackRequest;
  /** The whole request body, byte for byte, from its first byte (the commands included). */
  readonly body: ReadableStream<Uint8Array>;
  /** How many bytes of `body` the head spans: the pack (when there is one) starts at this offset. */
  readonly headLength: number;
}

const SHALLOW = /^shallow ([0-9a-f]{40})$/;
const COMMAND = /^(\S+) (\S+) (.+)$/;
/** Caps matching the {@link ReceivePackRequest} schema, enforced while reading. */
const MAX_SHALLOW = 10_000;
const MAX_COMMANDS = 10_000;
const MAX_PUSH_OPTIONS = 100;
/**
 * Default cap on the bytes before the pack (shallow lines, commands, push options). Real pushes
 * send a few kilobytes; 100 push options of the longest length fit with room to spare.
 */
export const DEFAULT_MAX_HEAD_BYTES = 8 * 1024 * 1024;

/** Options for {@link parseReceivePackRequest}. */
export interface ParseReceivePackOptions {
  /**
   * The most bytes the head may span before the pack; default {@link DEFAULT_MAX_HEAD_BYTES}.
   * The parser buffers at most this much plus the rest of the last chunk it pulled.
   */
  readonly maxHeadBytes?: number;
}

function malformed(reason: string): Error {
  return coreError('malformed_request', 'Malformed receive-pack request', { reason });
}

function unsupported(feature: string, message: string): Error {
  return coreError('unsupported_request', message, { feature });
}

/** The text of a packet that must be a data line. */
function requireLine(packet: Packet | null, where: string): string {
  if (packet === null) throw malformed(`request ends before the flush that closes the ${where}`);
  const text = packetText(packet);
  if (text === null) throw malformed(`unexpected ${packet.type} packet in the ${where}`);
  return text;
}

function parseCommand(line: string): ReceivePackCommand {
  const match = COMMAND.exec(line);
  if (match === null) throw malformed(`command line ${JSON.stringify(line)} is not "<old> <new> <ref>"`);
  const parsed = ReceivePackCommand.safeParse({ oldSha: match[1], newSha: match[2], ref: match[3] });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw malformed(
      `command ${JSON.stringify(line)}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}

function checkCapabilities(capabilities: readonly string[]): void {
  for (const capability of capabilities) {
    if (capability.startsWith('object-format=') && capability !== 'object-format=sha1') {
      throw unsupported(
        capability,
        `Unsupported object format: ${capability.slice('object-format='.length)}`,
      );
    }
  }
}

/**
 * Reads packets until a flush, appending the data lines to `lines` (any already read from the
 * section) and returning them; throws once the section holds more than `max`.
 */
async function readSection(
  reader: PktLineReader,
  where: string,
  max: number,
  lines: string[] = [],
): Promise<string[]> {
  let packet = await reader.read();
  while (packet?.type !== 'flush') {
    lines.push(requireLine(packet, where));
    if (lines.length > max) throw malformed(`more than ${max} lines in the ${where}`);
    packet = await reader.read();
  }
  return lines;
}

const shallowOf = (packet: Packet | null): string | null =>
  SHALLOW.exec((packet === null ? null : packetText(packet)) ?? '')?.[1] ?? null;

async function parseHead(reader: PktLineReader): Promise<ReceivePackRequest> {
  const shallow: string[] = [];
  let packet = await reader.read();
  let boundary = shallowOf(packet);
  while (boundary !== null) {
    shallow.push(boundary);
    if (shallow.length > MAX_SHALLOW) throw malformed(`more than ${MAX_SHALLOW} shallow lines`);
    packet = await reader.read();
    boundary = shallowOf(packet);
  }
  const firstLine = requireLine(packet, 'command list');
  if (firstLine.startsWith('push-cert')) throw unsupported('push-cert', 'Signed pushes are not supported');
  const nul = firstLine.indexOf('\0');
  const capabilities =
    nul === -1
      ? []
      : firstLine
          .slice(nul + 1)
          .split(' ')
          .filter((token) => token.length > 0);
  checkCapabilities(capabilities);
  const commandLines = await readSection(reader, 'command list', MAX_COMMANDS, [
    nul === -1 ? firstLine : firstLine.slice(0, nul),
  ]);
  const commands = commandLines.map(parseCommand);
  const pushOptions = capabilities.includes('push-options')
    ? await readSection(reader, 'push options', MAX_PUSH_OPTIONS)
    : [];
  const parsed = ReceivePackRequest.safeParse({ commands, capabilities, pushOptions, shallow });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw malformed(`${issue?.path.join('.') ?? 'request'}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/**
 * Parses the head of a protocol v0/v1 git-receive-pack request body — optional shallow lines,
 * the update commands (capabilities after a NUL on the first), and push options when the
 * "push-options" capability is requested — reading only those leading pkt-lines, never the pack.
 *
 * Returns the parsed head, `body`, a stream that replays the request from its first byte, so the
 * caller can forward it unchanged, and `headLength`, where the pack starts in it. Throws a malformed_pkt_line or malformed_request CoreError
 * for bad input — including more than 10000 shallow lines or commands, more than 100 push options,
 * or a head over `maxHeadBytes` — and unsupported_request for signed pushes and non-SHA-1 object
 * formats. On any failure the source stream is cancelled and released.
 */
export async function parseReceivePackRequest(
  stream: ReadableStream<Uint8Array>,
  options: ParseReceivePackOptions = {},
): Promise<ParsedReceivePack> {
  const reader = new PktLineReader(stream, {
    maxBytes: options.maxHeadBytes ?? DEFAULT_MAX_HEAD_BYTES,
  });
  let request: ReceivePackRequest;
  try {
    request = await parseHead(reader);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return { request, headLength: reader.offset, body: reader.replay() };
}
