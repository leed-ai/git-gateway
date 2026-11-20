// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, readAllBytes, streamOf } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import {
  DEFAULT_MAX_HEAD_BYTES,
  type ParseReceivePackOptions,
  parseReceivePackRequest,
} from '../../src/receive-pack/parse-request.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const COMMAND = `${A} ${B} refs/heads/main\n`;
const lines = (...parts: (string | Uint8Array)[]): Uint8Array =>
  concatBytes(parts.map((part) => (typeof part === 'string' ? encodePktLine(part) : part)));

async function failure(
  body: ReadableStream<Uint8Array>,
  options?: ParseReceivePackOptions,
): Promise<unknown> {
  return parseReceivePackRequest(body, options).then(
    () => undefined,
    (error: unknown) => error,
  );
}

const reasonOf = (error: unknown): string =>
  isCoreError(error, 'malformed_request') && error.body.code === 'malformed_request'
    ? error.body.details.reason
    : 'not a malformed_request';

/** A stream that serves `chunk` for ever, counting the pulls and noting a cancel. */
function endless(chunk: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => unknown;
} {
  let pulls = 0;
  let reason: unknown = null;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel(why) {
        reason = why;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => reason };
}

describe('parseReceivePackRequest limits', () => {
  it('accepts 10000 shallow lines and refuses the 10001st', async () => {
    const shallow = Array.from({ length: 10_000 }, () => `shallow ${A}\n`);
    const { request } = await parseReceivePackRequest(streamOf(lines(...shallow, COMMAND, FLUSH_PKT)));
    expect(request.shallow).toHaveLength(10_000);
    const error = await failure(streamOf(lines(...shallow, `shallow ${A}\n`, COMMAND, FLUSH_PKT)));
    expect(reasonOf(error)).toMatch(/more than 10000 shallow lines/);
  });

  it('stops an endless run of shallow lines without reading on', async () => {
    const source = endless(encodePktLine(`shallow ${A}\n`));
    const error = await failure(source.stream);
    expect(reasonOf(error)).toMatch(/shallow lines/);
    expect(source.pulls()).toBeLessThanOrEqual(10_002);
  });

  it('accepts 100 push options and refuses the 101st as soon as it arrives', async () => {
    const options = Array.from({ length: 100 }, (_, index) => `option-${index}\n`);
    const head = `${A} ${B} refs/heads/main\0report-status push-options\n`;
    const { request } = await parseReceivePackRequest(
      streamOf(lines(head, FLUSH_PKT, ...options, FLUSH_PKT)),
    );
    expect(request.pushOptions).toHaveLength(100);
    const unflushed = Array.from({ length: 101 }, (_, index) => `option-${index}\n`);
    const error = await failure(streamOf(lines(head, FLUSH_PKT, ...unflushed)));
    expect(reasonOf(error)).toMatch(/more than 100 lines in the push options/);
  });

  it('refuses a head that runs past maxHeadBytes, buffering little beyond it', async () => {
    const source = endless(encodePktLine(`${A} ${B} refs/heads/${'x'.repeat(900)}\n`));
    const error = await failure(source.stream, { maxHeadBytes: 64 * 1024 });
    expect(reasonOf(error)).toMatch(/65536-byte limit/);
    // Each chunk is one ~1 KB packet, so about 64 pulls reach the limit.
    expect(source.pulls()).toBeLessThanOrEqual(70);
  });

  it('allows a head that ends exactly at maxHeadBytes, with the pack in the same chunk', async () => {
    const head = lines(COMMAND, FLUSH_PKT);
    const body = concatBytes([head, new Uint8Array(100_000)]);
    const { body: replay } = await parseReceivePackRequest(streamOf(body), { maxHeadBytes: head.length });
    expect(await readAllBytes(replay)).toEqual(body);
  });

  it('defaults to an 8 MiB head, enough for 100 push options of the longest length', async () => {
    expect(DEFAULT_MAX_HEAD_BYTES).toBe(8 * 1024 * 1024);
    const head = `${A} ${B} refs/heads/main\0push-options\n`;
    const longest = 'o'.repeat(65_515);
    const options = Array.from({ length: 100 }, () => longest);
    const { request } = await parseReceivePackRequest(
      streamOf(lines(head, FLUSH_PKT, ...options, FLUSH_PKT)),
    );
    expect(request.pushOptions).toHaveLength(100);
  });
});

describe('parseReceivePackRequest failure cleanup', () => {
  it('cancels and unlocks the source stream when parsing fails', async () => {
    let cancelled: unknown = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(lines('not a command\n', FLUSH_PKT));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const error = await failure(stream);
    expect(isCoreError(error, 'malformed_request')).toBe(true);
    expect(cancelled).toBe(error);
    expect(stream.locked).toBe(false);
  });

  it('cancels an endless body stopped by a limit', async () => {
    const source = endless(encodePktLine(`shallow ${A}\n`));
    const error = await failure(source.stream);
    expect(source.cancelled()).toBe(error);
    expect(source.stream.locked).toBe(false);
  });

  it('still rethrows the parse error when the source refuses to cancel', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(lines('not a command\n', FLUSH_PKT));
      },
      cancel() {
        throw new Error('cannot cancel');
      },
    });
    const error = await failure(stream);
    expect(isCoreError(error, 'malformed_request')).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
