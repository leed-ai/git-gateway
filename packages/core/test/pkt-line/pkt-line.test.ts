// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { decodePktLines, packetText } from '../../src/pkt-line/decode.ts';
import {
  DELIM_PKT,
  encodePacket,
  encodePackets,
  encodePktLine,
  FLUSH_PKT,
  RESPONSE_END_PKT,
} from '../../src/pkt-line/encode.ts';
import { MAX_PKT_PAYLOAD } from '../../src/schemas/packet.ts';
import { arbitraryPacket } from '../helpers/arbitraries.ts';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function malformedAt(input: string): number | undefined {
  try {
    decodePktLines(bytes(input));
  } catch (error) {
    if (isCoreError(error, 'malformed_pkt_line') && error.body.code === 'malformed_pkt_line') {
      return error.body.details.offset;
    }
    throw error;
  }
  return undefined;
}

describe('encodePktLine', () => {
  it('prefixes the total length in four lowercase hex digits', () => {
    expect(text(encodePktLine('a\n'))).toBe('0006a\n');
    expect(text(encodePktLine(''))).toBe('0004');
    expect(text(encodePktLine(new Uint8Array(250)).subarray(0, 4))).toBe('00fe');
  });

  it('writes strings as UTF-8', () => {
    expect([...encodePktLine('é')]).toEqual([0x30, 0x30, 0x30, 0x36, 0xc3, 0xa9]);
  });

  it('accepts the largest payload and refuses one byte more', () => {
    expect(text(encodePktLine(new Uint8Array(MAX_PKT_PAYLOAD)).subarray(0, 4))).toBe('fff0');
    expect(() => encodePktLine(new Uint8Array(MAX_PKT_PAYLOAD + 1))).toThrow(RangeError);
  });

  it('encodes the special packets', () => {
    expect(text(FLUSH_PKT)).toBe('0000');
    expect(text(DELIM_PKT)).toBe('0001');
    expect(text(RESPONSE_END_PKT)).toBe('0002');
    expect(text(encodePacket({ type: 'delim' }))).toBe('0001');
    expect(text(encodePackets([{ type: 'data', payload: bytes('x') }, { type: 'flush' }]))).toBe('0005x0000');
  });

  it('rejects a packet that is not a packet', () => {
    expect(() => encodePacket(JSON.parse('{"type":"nope"}'))).toThrow(ZodError);
  });
});

describe('decodePktLines', () => {
  it('decodes data and special packets in order', () => {
    expect(decodePktLines(bytes('0006a\n000000010002'))).toEqual([
      { type: 'data', payload: bytes('a\n') },
      { type: 'flush' },
      { type: 'delim' },
      { type: 'response-end' },
    ]);
  });

  it('decodes an empty input and the empty data packet', () => {
    expect(decodePktLines(new Uint8Array(0))).toEqual([]);
    expect(decodePktLines(bytes('0004'))).toEqual([{ type: 'data', payload: new Uint8Array(0) }]);
  });

  it('accepts uppercase hex lengths', () => {
    expect(decodePktLines(bytes('000Aabcdef'))).toEqual([{ type: 'data', payload: bytes('abcdef') }]);
  });

  it.each([
    ['a non-hex header', 'zzzz', 0],
    ['length 3', '0003', 0],
    ['a truncated header', '0000ab', 4],
    ['a truncated payload', '0000000aabc', 4],
    ['a header with a sign', '+004', 0],
  ])('reports %s with its offset', (_, input, offset) => {
    expect(malformedAt(input)).toBe(offset);
  });

  it('reports a length beyond the maximum', () => {
    // 0xfff1 = 65521 is one byte over the largest packet.
    expect(malformedAt('fff1')).toBe(0);
  });

  it('round-trips any packet sequence', () => {
    fc.assert(
      fc.property(fc.array(arbitraryPacket, { maxLength: 20 }), (packets) => {
        expect(decodePktLines(encodePackets(packets))).toEqual(packets);
      }),
    );
  });
});

describe('packetText', () => {
  it('drops one trailing newline and nothing else', () => {
    expect(packetText({ type: 'data', payload: bytes('ok main\n\n') })).toBe('ok main\n');
    expect(packetText({ type: 'data', payload: bytes('no newline') })).toBe('no newline');
  });

  it('is null for a special packet', () => {
    expect(packetText({ type: 'flush' })).toBeNull();
  });
});
