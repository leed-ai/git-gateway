// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, readAllBytes, streamOf } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import { encodeReceivePackRequest } from '../../src/receive-pack/encode-request.ts';
import { parseReceivePackRequest } from '../../src/receive-pack/parse-request.ts';
import type { CoreErrorCode } from '../../src/schemas/core-error-body.ts';
import { arbitrarySha } from '../helpers/arbitraries.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const ZERO = '0'.repeat(40);
const PACK = new TextEncoder().encode('PACK\0\0\0\x02 pretend pack bytes');

const lines = (...parts: (string | Uint8Array)[]): Uint8Array =>
  concatBytes(parts.map((part) => (typeof part === 'string' ? encodePktLine(part) : part)));

async function failureOf(body: Uint8Array): Promise<{ code: CoreErrorCode; message: string } | undefined> {
  try {
    await parseReceivePackRequest(streamOf(body));
  } catch (error) {
    if (isCoreError(error)) return { code: error.code, message: JSON.stringify(error.body.details) };
    throw error;
  }
  return undefined;
}

describe('parseReceivePackRequest', () => {
  it('parses one command with capabilities and replays the body untouched', async () => {
    const body = lines(
      `${A} ${B} refs/heads/main\0report-status side-band-64k agent=git/2.43.0\n`,
      FLUSH_PKT,
      PACK,
    );
    const { request, body: replay } = await parseReceivePackRequest(streamOf(body));
    expect(request).toEqual({
      commands: [{ oldSha: A, newSha: B, ref: 'refs/heads/main' }],
      capabilities: ['report-status', 'side-band-64k', 'agent=git/2.43.0'],
      pushOptions: [],
      shallow: [],
    });
    expect(await readAllBytes(replay)).toEqual(body);
  });

  it('parses several commands, creations and deletions, with or without newlines', async () => {
    const body = lines(
      `${A} ${B} refs/heads/main\0report-status`,
      `${ZERO} ${B} refs/heads/new\n`,
      `${A} ${ZERO} refs/tags/v1`,
      FLUSH_PKT,
    );
    const { request } = await parseReceivePackRequest(streamOf(body));
    expect(request.commands).toEqual([
      { oldSha: A, newSha: B, ref: 'refs/heads/main' },
      { oldSha: ZERO, newSha: B, ref: 'refs/heads/new' },
      { oldSha: A, newSha: ZERO, ref: 'refs/tags/v1' },
    ]);
    expect(request.capabilities).toEqual(['report-status']);
  });

  it('accepts a first command without capabilities', async () => {
    const { request } = await parseReceivePackRequest(
      streamOf(lines(`${A} ${B} refs/heads/main\n`, FLUSH_PKT)),
    );
    expect(request.capabilities).toEqual([]);
  });

  it('reads push options when the capability is requested', async () => {
    const body = lines(
      `${A} ${B} refs/heads/main\0report-status push-options\n`,
      FLUSH_PKT,
      'ci.skip\n',
      'merge_request.create\n',
      '\n',
      FLUSH_PKT,
      PACK,
    );
    const { request, body: replay } = await parseReceivePackRequest(streamOf(body));
    expect(request.pushOptions).toEqual(['ci.skip', 'merge_request.create', '']);
    expect(await readAllBytes(replay)).toEqual(body);
  });

  it('does not read push options without the capability', async () => {
    const body = lines(`${A} ${B} refs/heads/main\0report-status\n`, FLUSH_PKT, 'ci.skip\n', FLUSH_PKT);
    expect((await parseReceivePackRequest(streamOf(body))).request.pushOptions).toEqual([]);
  });

  it('collects shallow lines sent before the commands', async () => {
    const body = lines(
      `shallow ${A}\n`,
      `shallow ${B}\n`,
      `${A} ${B} refs/heads/main\0report-status\n`,
      FLUSH_PKT,
    );
    expect((await parseReceivePackRequest(streamOf(body))).request.shallow).toEqual([A, B]);
  });

  it('reads only the leading commands, never the pack', async () => {
    let pulls = 0;
    const chunks = [lines(`${A} ${B} refs/heads/main\0report-status\n`, FLUSH_PKT), PACK, PACK];
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[pulls];
          pulls += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const { body } = await parseReceivePackRequest(source);
    expect(pulls).toBe(1);
    expect(await readAllBytes(body)).toEqual(concatBytes(chunks));
  });

  it('round-trips what encodeReceivePackRequest writes', async () => {
    const command = fc.record({
      oldSha: arbitrarySha,
      newSha: arbitrarySha,
      ref: fc.stringMatching(/^refs\/heads\/[a-z][a-z0-9-]{0,20}$/),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(command, { minLength: 1, maxLength: 5, selector: (c) => c.ref }),
        fc.array(fc.stringMatching(/^[a-z.=_]{0,20}$/), { maxLength: 3 }),
        async (commands, pushOptions) => {
          const body = encodeReceivePackRequest({ commands, pushOptions, pack: PACK });
          const { request } = await parseReceivePackRequest(streamOf(body));
          expect(request.commands).toEqual(commands);
          expect(request.pushOptions).toEqual(pushOptions);
        },
      ),
      { numRuns: 50 },
    );
  });

  it.each<[string, Uint8Array, CoreErrorCode, RegExp]>([
    ['an empty body', new Uint8Array(0), 'malformed_request', /ends before/],
    ['a flush with no commands', FLUSH_PKT, 'malformed_request', /unexpected flush/],
    [
      'a missing flush',
      lines(`${A} ${B} refs/heads/main\0report-status\n`),
      'malformed_request',
      /ends before/,
    ],
    [
      'a delim packet among commands',
      lines(`${A} ${B} refs/heads/main\n`, new TextEncoder().encode('0001')),
      'malformed_request',
      /delim/,
    ],
    ['a short line', lines('nocommand\n', FLUSH_PKT), 'malformed_request', /not \\"<old>/],
    ['an abbreviated id', lines(`abc ${B} refs/heads/main\n`, FLUSH_PKT), 'malformed_request', /oldSha/],
    [
      'an uppercase id',
      lines(`${A.toUpperCase()} ${B} refs/heads/main\n`, FLUSH_PKT),
      'malformed_request',
      /oldSha/,
    ],
    ['a ref outside refs/', lines(`${A} ${B} HEAD\n`, FLUSH_PKT), 'malformed_request', /ref/],
    ['a ref with ".."', lines(`${A} ${B} refs/heads/a..b\n`, FLUSH_PKT), 'malformed_request', /ref/],
    [
      'a ref ending in ".lock"',
      lines(`${A} ${B} refs/heads/x.lock\n`, FLUSH_PKT),
      'malformed_request',
      /ref/,
    ],
    [
      'the same ref twice',
      lines(`${A} ${B} refs/heads/main\n`, `${B} ${A} refs/heads/main\n`, FLUSH_PKT),
      'malformed_request',
      /at most one command/,
    ],
    [
      'push options without their flush',
      lines(`${A} ${B} refs/heads/main\0push-options\n`, FLUSH_PKT, 'x\n'),
      'malformed_request',
      /push options/,
    ],
    ['a bad pkt-line header', new TextEncoder().encode('zzzz'), 'malformed_pkt_line', /zzzz/],
    ['a signed push', lines('push-cert\0report-status\n', FLUSH_PKT), 'unsupported_request', /push-cert/],
    [
      'a SHA-256 repository',
      lines(`${A} ${B} refs/heads/main\0object-format=sha256\n`, FLUSH_PKT),
      'unsupported_request',
      /sha256/,
    ],
  ])('refuses %s', async (_, body, code, detail) => {
    const failure = await failureOf(body);
    expect(failure?.code).toBe(code);
    expect(failure?.message).toMatch(detail);
  });

  it('accepts the SHA-1 object format capability', async () => {
    const body = lines(`${A} ${B} refs/heads/main\0object-format=sha1\n`, FLUSH_PKT);
    expect((await parseReceivePackRequest(streamOf(body))).request.capabilities).toEqual([
      'object-format=sha1',
    ]);
  });

  it('stops a body that never sends its flush once it passes 10000 commands', async () => {
    const many = Array.from({ length: 10_001 }, (_, index) => `${A} ${B} refs/heads/b${index}\n`);
    const failure = await failureOf(lines(...many));
    expect(failure?.code).toBe('malformed_request');
    expect(failure?.message).toMatch(/more than 10000 lines in the command list/);
  });

  it('accepts exactly 10000 commands', async () => {
    const many = Array.from({ length: 10_000 }, (_, index) => `${A} ${B} refs/heads/b${index}\n`);
    const { request } = await parseReceivePackRequest(streamOf(lines(...many, FLUSH_PKT)));
    expect(request.commands).toHaveLength(10_000);
  });
});
