// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { decodePktLines } from '../../src/pkt-line/decode.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import {
  encodeErrPacket,
  encodeReportStatus,
  parseReportStatus,
  reportStatusFraming,
} from '../../src/receive-pack/report-status.ts';
import {
  BAND_DATA,
  BAND_ERROR,
  BAND_PROGRESS,
  demultiplexSideBand,
  encodeSideBand,
  SIDE_BAND_64K_MAX_PAYLOAD,
  SIDE_BAND_MAX_PAYLOAD,
} from '../../src/receive-pack/side-band.ts';
import type { CoreErrorCode } from '../../src/schemas/core-error-body.ts';
import type { ReportStatus } from '../../src/schemas/report-status.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const lines = (...parts: (string | Uint8Array)[]): Uint8Array =>
  concatBytes(parts.map((part) => (typeof part === 'string' ? encodePktLine(part) : part)));

const REPORT: ReportStatus = {
  unpack: 'ok',
  refs: [
    { ref: 'refs/heads/main', status: 'ok' },
    { ref: 'refs/heads/staging', status: 'ng', reason: 'fetch first' },
  ],
};

function failureCode(run: () => unknown): CoreErrorCode | undefined {
  try {
    run();
  } catch (error) {
    if (isCoreError(error)) return error.code;
    throw error;
  }
  return undefined;
}

describe('parseReportStatus', () => {
  it('parses a plain report', () => {
    const response = lines(
      'unpack ok\n',
      'ok refs/heads/main\n',
      'ng refs/heads/staging fetch first\n',
      FLUSH_PKT,
    );
    expect(parseReportStatus(response, { sideBand: 'none' })).toEqual(REPORT);
  });

  it('parses a report carried on side-band channel 1, ignoring progress', () => {
    const inner = lines(
      'unpack ok\n',
      'ok refs/heads/main\n',
      'ng refs/heads/staging fetch first\n',
      FLUSH_PKT,
    );
    const response = concatBytes([
      encodeSideBand(BAND_PROGRESS, bytes('Resolving deltas: 100%\n')),
      encodeSideBand(BAND_DATA, inner.subarray(0, 10)),
      encodeSideBand(BAND_DATA, inner.subarray(10)),
      FLUSH_PKT,
    ]);
    expect(parseReportStatus(response, { sideBand: 'side-band-64k' })).toEqual(REPORT);
  });

  it('keeps an unpack error and an ng line without a reason', () => {
    const response = lines('unpack index-pack abnormal exit\n', 'ng refs/heads/main\n', FLUSH_PKT);
    expect(parseReportStatus(response, { sideBand: 'none' })).toEqual({
      unpack: 'index-pack abnormal exit',
      refs: [{ ref: 'refs/heads/main', status: 'ng', reason: 'rejected' }],
    });
  });

  it('skips report-status-v2 option lines', () => {
    const response = lines(
      'unpack ok\n',
      'ok refs/heads/main\n',
      'option refname refs/heads/main\n',
      FLUSH_PKT,
    );
    expect(parseReportStatus(response, { sideBand: 'none' }).refs).toEqual([
      { ref: 'refs/heads/main', status: 'ok' },
    ]);
  });

  it('reports an ERR packet as a remote error', () => {
    const response = encodeErrPacket('access denied');
    expect(failureCode(() => parseReportStatus(response, { sideBand: 'none' }))).toBe('remote_error');
    expect(failureCode(() => parseReportStatus(response, { sideBand: 'side-band-64k' }))).toBe(
      'remote_error',
    );
  });

  it('reports a channel-3 message as a remote error with its text', () => {
    const response = concatBytes([encodeSideBand(BAND_ERROR, bytes('repository is read-only\n')), FLUSH_PKT]);
    let thrown: unknown;
    try {
      parseReportStatus(response, { sideBand: 'side-band-64k' });
    } catch (error) {
      thrown = error;
    }
    expect(isCoreError(thrown, 'remote_error') && thrown.body).toMatchObject({
      details: { remoteMessage: 'repository is read-only' },
    });
  });

  it.each([
    ['a report without unpack', lines('ok refs/heads/main\n', FLUSH_PKT)],
    ['an empty response', new Uint8Array(0)],
    ['an unknown status word', lines('unpack ok\n', 'maybe refs/heads/main\n', FLUSH_PKT)],
    ['a bad ref in a status line', lines('unpack ok\n', 'ok not-a-ref\n', FLUSH_PKT)],
  ])('refuses %s', (_, response) => {
    expect(failureCode(() => parseReportStatus(response, { sideBand: 'none' }))).toBe('malformed_request');
  });
});

describe('demultiplexSideBand', () => {
  it('joins channel 1 and collects progress, stopping at a flush', () => {
    const packets = decodePktLines(
      concatBytes([
        encodeSideBand(BAND_DATA, bytes('ab')),
        encodeSideBand(BAND_PROGRESS, bytes('50%\r')),
        encodeSideBand(BAND_DATA, bytes('cd')),
        FLUSH_PKT,
        encodeSideBand(BAND_DATA, bytes('ignored')),
      ]),
    );
    expect(demultiplexSideBand(packets)).toEqual({ data: bytes('abcd'), progress: '50%\r' });
  });

  it.each([
    ['an unknown channel', encodePktLine(Uint8Array.of(7, 0x61))],
    ['an empty packet', encodePktLine(new Uint8Array(0))],
    ['a delim packet', bytes('0001')],
  ])('refuses %s', (_, framed) => {
    expect(failureCode(() => demultiplexSideBand(decodePktLines(framed)))).toBe('malformed_request');
  });

  it('keeps a UTF-8 character split across two progress packets whole', () => {
    const text = bytes('Écriture des objets: 100% ✓\n');
    for (let cut = 1; cut < text.length; cut += 1) {
      const packets = decodePktLines(
        concatBytes([
          encodeSideBand(BAND_PROGRESS, text.subarray(0, cut)),
          encodeSideBand(BAND_PROGRESS, text.subarray(cut)),
          FLUSH_PKT,
        ]),
      );
      expect(demultiplexSideBand(packets).progress).toBe('Écriture des objets: 100% ✓\n');
    }
  });

  it('replaces a truncated trailing character once, at the end', () => {
    const packets = decodePktLines(
      concatBytes([encodeSideBand(BAND_PROGRESS, Uint8Array.of(0x61, 0xe2, 0x9c)), FLUSH_PKT]),
    );
    expect(demultiplexSideBand(packets).progress).toBe('a\uFFFD');
  });
});

describe('reportStatusFraming', () => {
  it.each([
    [['report-status'], 'none'],
    [['report-status', 'side-band'], 'side-band'],
    [['side-band-64k', 'report-status'], 'side-band-64k'],
    [['side-band', 'side-band-64k'], 'side-band-64k'],
  ] as const)('chooses the framing for %j', (capabilities, sideBand) => {
    expect(reportStatusFraming(capabilities)).toEqual({ sideBand });
  });
});

describe('encodeSideBand', () => {
  it('defaults to side-band-64k packets', () => {
    const packets = decodePktLines(encodeSideBand(BAND_DATA, new Uint8Array(SIDE_BAND_64K_MAX_PAYLOAD + 1)));
    expect(packets.map((packet) => (packet.type === 'data' ? packet.payload.length : 0))).toEqual([
      65_516, 2,
    ]);
  });

  it('uses 995-byte payloads for side-band, so packets are at most 1000 bytes', () => {
    const encoded = encodeSideBand(BAND_DATA, new Uint8Array(2000), SIDE_BAND_MAX_PAYLOAD);
    const packets = decodePktLines(encoded);
    expect(packets.map((packet) => (packet.type === 'data' ? packet.payload.length + 4 : 0))).toEqual([
      1000, 1000, 15,
    ]);
  });

  it('splits data into packets of at most the given payload', () => {
    const packets = decodePktLines(encodeSideBand(BAND_DATA, new Uint8Array(2500), 999));
    expect(packets.map((packet) => (packet.type === 'data' ? packet.payload.length : 0))).toEqual([
      1000, 1000, 503,
    ]);
  });
});

describe('encodeReportStatus', () => {
  it.each(['none', 'side-band', 'side-band-64k'] as const)(
    'round-trips through parseReportStatus (%s)',
    (sideBand) => {
      expect(parseReportStatus(encodeReportStatus(REPORT, { sideBand }), { sideBand })).toEqual(REPORT);
    },
  );

  it.each([
    ['side-band', 1000],
    ['side-band-64k', 65_520],
  ] as const)('keeps every %s packet within %d bytes', (sideBand, limit) => {
    const refs = Array.from({ length: 3000 }, (_, index) => ({
      ref: `refs/heads/branch-${index}`,
      status: 'ng' as const,
      reason: 'fetch first',
    }));
    const report = { unpack: 'ok', refs };
    const encoded = encodeReportStatus(report, { sideBand });
    const sizes = decodePktLines(encoded).map((packet) =>
      packet.type === 'data' ? packet.payload.length + 4 : 4,
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(limit);
    expect(sizes.filter((size) => size === limit).length).toBeGreaterThan(0);
    expect(parseReportStatus(encoded, { sideBand })).toEqual(report);
  });

  it('writes the lines git expects', () => {
    expect(new TextDecoder().decode(encodeReportStatus(REPORT, { sideBand: 'none' }))).toBe(
      '000eunpack ok\n0017ok refs/heads/main\n0026ng refs/heads/staging fetch first\n0000',
    );
  });

  it('refuses a reason spanning lines', () => {
    expect(() =>
      encodeReportStatus(
        { unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ng', reason: 'a\nb' }] },
        { sideBand: 'none' },
      ),
    ).toThrow(ZodError);
  });
});

describe('encodeErrPacket', () => {
  it('writes one ERR line', () => {
    expect(new TextDecoder().decode(encodeErrPacket('no\nway'))).toBe('000fERR no way\n');
  });
});
