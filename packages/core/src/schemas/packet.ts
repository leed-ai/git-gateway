// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** The most payload bytes one pkt-line carries: 65520 minus the 4-byte length header. */
export const MAX_PKT_PAYLOAD = 65_516;

/** Raw bytes. */
export const Bytes = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, { message: 'expected a Uint8Array' })
  .meta({
    id: 'Bytes',
    title: 'Bytes',
    description: 'Raw bytes as a Uint8Array (a Node or Bun Buffer is accepted, being a Uint8Array).',
    examples: [new Uint8Array([0x50, 0x41, 0x43, 0x4b])],
  });

/** A pkt-line that carries a payload. */
export const DataPacket = z
  .object({
    type: z
      .literal('data')
      .describe('A pkt-line with a payload: a 4-hex-digit length header, then the payload.'),
    payload: Bytes.refine((bytes) => bytes.length <= MAX_PKT_PAYLOAD, {
      message: `payload exceeds ${MAX_PKT_PAYLOAD} bytes`,
    }).describe(
      'The payload, 0–65516 bytes, including any trailing newline the sender wrote. An empty payload is the "0004" packet.',
    ),
  })
  .strict()
  .meta({
    id: 'DataPacket',
    title: 'Data pkt-line',
    description:
      'A pkt-line carrying a payload, framed as a 4-hex-digit total length followed by the payload.',
    examples: [{ type: 'data', payload: new Uint8Array([0x6f, 0x6b, 0x0a]) }],
  });

/** The special packets git uses to delimit sections. */
export const SpecialPacket = z
  .object({
    type: z.enum(['flush', 'delim', 'response-end']).meta({
      description: 'Which special packet this is.',
      enumDescriptions: {
        flush: '"0000": ends a list of pkt-lines (a section or a message).',
        delim: '"0001": separates sections of a protocol v2 message.',
        'response-end': '"0002": ends a stateless protocol v2 response.',
      },
    }),
  })
  .strict()
  .meta({
    id: 'SpecialPacket',
    title: 'Special pkt-line',
    description:
      'A length-only pkt-line with no payload: flush ("0000"), delim ("0001") or response-end ("0002").',
    examples: [{ type: 'flush' }],
  });

/** One pkt-line: a data packet or a special packet. */
export const Packet = z.union([DataPacket, SpecialPacket]).meta({
  id: 'Packet',
  title: 'pkt-line',
  description: 'One unit of git pkt-line framing: a data packet, or a flush, delim or response-end packet.',
  examples: [{ type: 'flush' }, { type: 'data', payload: new Uint8Array([0x6f, 0x6b, 0x0a]) }],
});

/** One pkt-line, inferred from {@link Packet}. */
export type Packet = z.infer<typeof Packet>;
