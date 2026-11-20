// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import { concatBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { decodePktLines, packetText } from '../../src/pkt-line/decode.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import { encodeSideBand } from '../../src/receive-pack/side-band.ts';
import { encodeUploadPackRequest } from '../../src/upload-pack/encode-request.ts';
import { parseUploadPackResponse } from '../../src/upload-pack/parse-response.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const PACK = new TextEncoder().encode('PACK-bytes');

const textLines = (bytes: Uint8Array): (string | null)[] => decodePktLines(bytes).map(packetText);

/** The CoreError code `run` throws, or null. */
function thrownCode(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isCoreError(error) ? error.code : null;
  }
  return null;
}

describe('encodeUploadPackRequest', () => {
  it('writes wants with capabilities on the first, haves, then done', () => {
    expect(textLines(encodeUploadPackRequest({ wants: [A, B, A], haves: [B, B] }))).toEqual([
      `want ${A} side-band-64k ofs-delta no-progress`,
      `want ${B}`,
      null,
      `have ${B}`,
      'done',
    ]);
  });

  it('adds deepen and filter lines and their capabilities', () => {
    expect(
      textLines(encodeUploadPackRequest({ wants: [A], capabilities: [], depth: 1, filter: 'tree:0' })),
    ).toEqual([`want ${A} shallow filter`, 'deepen 1', 'filter tree:0', null, 'done']);
  });

  it('writes a bare want line when there are no capabilities', () => {
    expect(textLines(encodeUploadPackRequest({ wants: [A], capabilities: [] }))[0]).toBe(`want ${A}`);
  });

  it('rejects requests the schema refuses', () => {
    expect(() => encodeUploadPackRequest({ wants: [] })).toThrow(ZodError);
    expect(() => encodeUploadPackRequest({ wants: [A], filter: 'sparse:oid=x' })).toThrow(ZodError);
  });
});

describe('parseUploadPackResponse', () => {
  it('reads NAK and a side-band pack, with progress', () => {
    const response = concatBytes([
      encodePktLine('NAK\n'),
      encodeSideBand(2, new TextEncoder().encode('Counting\n')),
      encodeSideBand(1, PACK.subarray(0, 4)),
      encodeSideBand(1, PACK.subarray(4)),
      FLUSH_PKT,
    ]);
    expect(parseUploadPackResponse(response, { deepen: false, sideBand: true })).toEqual({
      shallow: [],
      acknowledged: [],
      pack: PACK,
      progress: 'Counting\n',
    });
  });

  it('reads shallow lines before the acknowledgement, and a raw pack without side-band', () => {
    const response = concatBytes([
      encodePktLine(`shallow ${A}\n`),
      encodePktLine(`unshallow ${B}\n`),
      FLUSH_PKT,
      encodePktLine(`ACK ${B}\n`),
      PACK,
    ]);
    expect(parseUploadPackResponse(response, { deepen: true, sideBand: false })).toEqual({
      shallow: [A],
      acknowledged: [B],
      pack: PACK,
      progress: '',
    });
  });

  it('reads multi_ack status lines until the final ACK', () => {
    const response = concatBytes([encodePktLine(`ACK ${A} common\n`), encodePktLine(`ACK ${B}\n`), PACK]);
    expect(parseUploadPackResponse(response, { deepen: false, sideBand: false }).acknowledged).toEqual([
      A,
      B,
    ]);
  });

  it('returns an empty pack when the answer stops after the shallow list', () => {
    const response = concatBytes([encodePktLine(`shallow ${A}\n`), FLUSH_PKT]);
    expect(parseUploadPackResponse(response, { deepen: true, sideBand: true }).pack.length).toBe(0);
  });

  it('reports ERR lines and channel-3 messages as remote errors', () => {
    expect(
      thrownCode(() =>
        parseUploadPackResponse(encodePktLine('ERR upload-pack: not our ref\n'), {
          deepen: false,
          sideBand: true,
        }),
      ),
    ).toBe('remote_error');
    expect(
      thrownCode(() => parseUploadPackResponse(encodePktLine('ERR no\n'), { deepen: true, sideBand: true })),
    ).toBe('remote_error');
    const channelThree = concatBytes([
      encodePktLine('NAK\n'),
      encodeSideBand(3, new TextEncoder().encode('fatal\n')),
    ]);
    expect(thrownCode(() => parseUploadPackResponse(channelThree, { deepen: false, sideBand: true }))).toBe(
      'remote_error',
    );
  });

  it('rejects unexpected lines, flushes, channels and truncation', () => {
    expect(
      thrownCode(() => parseUploadPackResponse(encodePktLine('hello\n'), { deepen: false, sideBand: true })),
    ).toBe('malformed_request');
    expect(thrownCode(() => parseUploadPackResponse(FLUSH_PKT, { deepen: false, sideBand: true }))).toBe(
      'malformed_request',
    );
    expect(
      thrownCode(() =>
        parseUploadPackResponse(concatBytes([encodePktLine('bogus\n'), FLUSH_PKT]), {
          deepen: true,
          sideBand: true,
        }),
      ),
    ).toBe('malformed_request');
    expect(
      thrownCode(() =>
        parseUploadPackResponse(concatBytes([encodePktLine('NAK\n'), encodeSideBand(7, PACK)]), {
          deepen: false,
          sideBand: true,
        }),
      ),
    ).toBe('malformed_request');
    expect(
      thrownCode(() =>
        parseUploadPackResponse(new TextEncoder().encode('00'), { deepen: false, sideBand: true }),
      ),
    ).toBe('malformed_pkt_line');
    expect(
      thrownCode(() =>
        parseUploadPackResponse(new TextEncoder().encode('0010NAK'), { deepen: false, sideBand: true }),
      ),
    ).toBe('malformed_pkt_line');
  });
});
