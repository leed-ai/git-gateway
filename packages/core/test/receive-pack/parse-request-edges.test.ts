// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, readAllBytes, streamOf } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import { parseReceivePackRequest } from '../../src/receive-pack/parse-request.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const lines = (...parts: (string | Uint8Array)[]): Uint8Array =>
  concatBytes(parts.map((part) => (typeof part === 'string' ? encodePktLine(part) : part)));

async function failure(body: ReadableStream<Uint8Array>): Promise<unknown> {
  return parseReceivePackRequest(body).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('parseReceivePackRequest edge cases', () => {
  it('accepts an empty push-options section', async () => {
    const body = lines(`${A} ${B} refs/heads/main\0push-options\n`, FLUSH_PKT, FLUSH_PKT);
    const { request, body: replay } = await parseReceivePackRequest(streamOf(body));
    expect(request.pushOptions).toEqual([]);
    expect(await readAllBytes(replay)).toEqual(body);
  });

  it('ignores empty capability tokens and an empty capability list', async () => {
    const spaced = await parseReceivePackRequest(
      streamOf(lines(`${A} ${B} refs/heads/main\0 report-status  quiet \n`, FLUSH_PKT)),
    );
    expect(spaced.request.capabilities).toEqual(['report-status', 'quiet']);
    const bare = await parseReceivePackRequest(streamOf(lines(`${A} ${B} refs/heads/main\0\n`, FLUSH_PKT)));
    expect(bare.request.capabilities).toEqual([]);
  });

  it('treats a shallow line with a bad id as a malformed command', async () => {
    const error = await failure(streamOf(lines(`shallow abc\n`, `${A} ${B} refs/heads/main\n`, FLUSH_PKT)));
    expect(isCoreError(error, 'malformed_request')).toBe(true);
  });

  it('refuses a shallow-only body that never sends a command', async () => {
    const error = await failure(streamOf(lines(`shallow ${A}\n`, FLUSH_PKT)));
    expect(isCoreError(error, 'malformed_request')).toBe(true);
  });

  it('refuses a delim packet in the push options', async () => {
    const error = await failure(
      streamOf(lines(`${A} ${B} refs/heads/main\0push-options\n`, FLUSH_PKT, text('0001'), FLUSH_PKT)),
    );
    expect(isCoreError(error, 'malformed_request')).toBe(true);
  });

  it('refuses a pkt-line cut off in the middle of its payload', async () => {
    const whole = encodePktLine(`${A} ${B} refs/heads/main\n`);
    const error = await failure(streamOf(whole.slice(0, whole.length - 5)));
    expect(isCoreError(error)).toBe(true);
  });

  it('refuses the reserved pkt-line length 0003', async () => {
    const error = await failure(streamOf(text('0003')));
    expect(isCoreError(error, 'malformed_pkt_line')).toBe(true);
  });

  it('passes on an error from the source stream', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodePktLine(`${A} ${B} refs/heads/main\n`));
        controller.error(new Error('connection reset'));
      },
    });
    await expect(parseReceivePackRequest(source)).rejects.toThrow('connection reset');
  });
});
