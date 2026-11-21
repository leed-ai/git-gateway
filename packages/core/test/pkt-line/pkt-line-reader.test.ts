// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, readAllBytes, streamOf } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { encodePackets } from '../../src/pkt-line/encode.ts';
import { PktLineReader } from '../../src/pkt-line/pkt-line-reader.ts';
import type { Packet } from '../../src/schemas/packet.ts';
import { arbitraryPacket } from '../helpers/arbitraries.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Splits bytes at the given cut points into chunks. */
function chunked(input: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((cut) => cut % (input.length + 1)))].toSorted((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const point of [...points, input.length]) {
    if (point > start) chunks.push(input.slice(start, point));
    start = Math.max(start, point);
  }
  return chunks;
}

async function readAll(reader: PktLineReader): Promise<Packet[]> {
  const packets: Packet[] = [];
  for (let packet = await reader.read(); packet !== null; packet = await reader.read()) packets.push(packet);
  return packets;
}

/** A stream over chunks that counts how many chunks were pulled. */
function countingStream(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulled];
        pulled += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulled };
}

describe('PktLineReader', () => {
  it('reads packets across arbitrary chunk boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryPacket, { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        async (packets, cuts) => {
          const reader = new PktLineReader(streamOf(...chunked(encodePackets(packets), cuts)));
          expect(await readAll(reader)).toEqual(packets);
          expect(reader.offset).toBe(encodePackets(packets).length);
        },
      ),
    );
  });

  it('pulls only the chunks it needs', async () => {
    const { stream, pulls } = countingStream([bytes('0006a\n'), bytes('0000'), bytes('PACK...')]);
    const reader = new PktLineReader(stream);
    expect(await reader.read()).toEqual({ type: 'data', payload: bytes('a\n') });
    expect(await reader.read()).toEqual({ type: 'flush' });
    expect(pulls()).toBe(2);
  });

  it('replays the whole input after reading part of it', async () => {
    const input = bytes('0006a\n0000PACK-and-the-rest');
    const reader = new PktLineReader(streamOf(input.slice(0, 7), input.slice(7, 12), input.slice(12)));
    await reader.read();
    await reader.read();
    expect(await readAllBytes(reader.replay())).toEqual(input);
  });

  it('continues with the bytes after the last packet', async () => {
    const input = bytes('0006a\n0000PACK-and-the-rest');
    const reader = new PktLineReader(streamOf(input.slice(0, 12), input.slice(12)));
    await reader.read();
    await reader.read();
    expect(new TextDecoder().decode(await readAllBytes(reader.rest()))).toBe('PACK-and-the-rest');
  });

  it('hands off the remaining stream after the source has ended', async () => {
    const reader = new PktLineReader(streamOf(bytes('0000')));
    expect(await reader.read()).toEqual({ type: 'flush' });
    expect(await reader.read()).toBeNull();
    expect(await readAllBytes(reader.rest())).toEqual(new Uint8Array(0));
  });

  it('hands the stream off only once', async () => {
    const reader = new PktLineReader(streamOf(bytes('0000')));
    reader.replay();
    expect(() => reader.rest()).toThrow(/already handed off/);
  });

  it('cancels the source when the handed-off stream is cancelled', async () => {
    let cancelled: unknown;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes('0000'));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const reader = new PktLineReader(source);
    await reader.read();
    await reader.rest().cancel('stop');
    expect(cancelled).toBe('stop');
  });

  it.each([
    ['inside a header', '00'],
    ['inside a payload', '0009ab'],
  ])('reports input ending %s', async (_, input) => {
    const reader = new PktLineReader(streamOf(bytes(input)));
    const error: unknown = await reader.read().catch((thrown: unknown) => thrown);
    expect(isCoreError(error, 'malformed_pkt_line')).toBe(true);
  });

  it('keeps payloads independent of later chunks', async () => {
    const first = concatBytes([bytes('0005a'), bytes('0005b')]);
    const reader = new PktLineReader(streamOf(first));
    const a = await reader.read();
    const b = await reader.read();
    expect([a, b]).toEqual([
      { type: 'data', payload: bytes('a') },
      { type: 'data', payload: bytes('b') },
    ]);
  });

  it('reads packets that end exactly at maxBytes and refuses one that runs past it', async () => {
    const input = bytes('0005a0005b0000');
    const reader = new PktLineReader(streamOf(input), { maxBytes: 10 });
    expect(await reader.read()).toEqual({ type: 'data', payload: bytes('a') });
    expect(await reader.read()).toEqual({ type: 'data', payload: bytes('b') });
    const error = await reader.read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isCoreError(error, 'malformed_request')).toBe(true);
  });

  it('checks maxBytes against the announced packet length before pulling its payload', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(pulls === 1 ? bytes('fff0') : new Uint8Array(1000));
        },
      },
      { highWaterMark: 0 },
    );
    const reader = new PktLineReader(source, { maxBytes: 4096 });
    await expect(reader.read()).rejects.toThrow('Too many bytes of pkt-lines');
    expect(pulls).toBe(1);
  });

  it('cancels and unlocks the source, and does nothing once handed off', async () => {
    let reason: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      cancel(why) {
        reason = why;
      },
    });
    const reader = new PktLineReader(source);
    await reader.cancel('stop');
    expect(reason).toBe('stop');
    expect(source.locked).toBe(false);
    await reader.cancel('again');
    expect(reason).toBe('stop');

    const handed = new PktLineReader(streamOf(bytes('0000')));
    const rest = handed.rest();
    await handed.cancel('ignored');
    expect(await readAllBytes(rest)).toEqual(bytes('0000'));
  });
});
