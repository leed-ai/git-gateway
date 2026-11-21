// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { encodePktLine, FLUSH_PKT } from '../../src/pkt-line/encode.ts';
import { encodeRefAdvertisement, parseRefAdvertisement } from '../../src/smart-http/ref-advertisement.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const ZERO = '0'.repeat(40);

/** The CoreError code `run` throws, or null. */
function thrownCode(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isCoreError(error) ? error.code : null;
  }
  return null;
}

const lines = (...payloads: (string | null)[]): Uint8Array =>
  concatBytes(payloads.map((payload) => (payload === null ? FLUSH_PKT : encodePktLine(payload))));

describe('ref advertisement', () => {
  it('round-trips refs, capabilities, symrefs and peeled tags', () => {
    const advertisement = {
      service: 'git-upload-pack' as const,
      refs: [
        { name: 'HEAD' as const, sha: A, peeled: null },
        { name: 'refs/heads/main', sha: A, peeled: null },
        { name: 'refs/tags/v1', sha: B, peeled: A },
      ],
      capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
      symrefs: { HEAD: 'refs/heads/main' },
    };
    expect(parseRefAdvertisement(encodeRefAdvertisement(advertisement), 'git-upload-pack')).toEqual(
      advertisement,
    );
  });

  it('encodes an empty repository with the capabilities^{} line and parses it back to no refs', () => {
    const encoded = encodeRefAdvertisement({
      service: 'git-receive-pack',
      refs: [],
      capabilities: ['report-status'],
      symrefs: {},
    });
    expect(new TextDecoder().decode(encoded)).toContain(`${ZERO} capabilities^{}\0report-status`);
    expect(parseRefAdvertisement(encoded, 'git-receive-pack')).toEqual({
      service: 'git-receive-pack',
      refs: [],
      capabilities: ['report-status'],
      symrefs: {},
    });
  });

  it('parses an advertisement without the smart-HTTP preamble, and skips "version 1"', () => {
    const parsed = parseRefAdvertisement(
      lines('version 1\n', `${A} refs/heads/main\0atomic\n`, null),
      'git-receive-pack',
    );
    expect(parsed.refs).toEqual([{ name: 'refs/heads/main', sha: A, peeled: null }]);
    expect(parsed.capabilities).toEqual(['atomic']);
  });

  it('parses a first line without capabilities and ignores malformed symrefs', () => {
    expect(
      parseRefAdvertisement(
        lines('# service=git-upload-pack\n', `${A} refs/heads/main\n`, null),
        'git-upload-pack',
      ).capabilities,
    ).toEqual([]);
    const parsed = parseRefAdvertisement(
      lines(`${A} HEAD\0symref=HEAD symref=:refs/heads/x symref=HEAD:main\n`, null),
      'git-upload-pack',
    );
    expect(parsed.symrefs).toEqual({});
  });

  it('rejects another service, protocol v2, bad lines, stray peeled lines and bad ref names', () => {
    expect(
      thrownCode(() =>
        parseRefAdvertisement(lines('# service=git-receive-pack\n', null, null), 'git-upload-pack'),
      ),
    ).toBe('malformed_request');
    expect(
      thrownCode(() => parseRefAdvertisement(lines('version 2\n', 'ls-refs\n', null), 'git-upload-pack')),
    ).toBe('unsupported_request');
    expect(thrownCode(() => parseRefAdvertisement(lines('not a ref line\n', null), 'git-upload-pack'))).toBe(
      'malformed_request',
    );
    expect(
      thrownCode(() =>
        parseRefAdvertisement(
          lines(`${A} refs/heads/main\0\n`, `${B} refs/tags/v1^{}\n`, null),
          'git-upload-pack',
        ),
      ),
    ).toBe('malformed_request');
    expect(
      thrownCode(() =>
        parseRefAdvertisement(lines(`${A} refs/heads/bad..name\0\n`, null), 'git-upload-pack'),
      ),
    ).toBe('malformed_request');
    expect(
      thrownCode(() =>
        parseRefAdvertisement(
          concatBytes([encodePktLine(`${A} refs/heads/main\0\n`), new TextEncoder().encode('0001')]),
          'git-upload-pack',
        ),
      ),
    ).toBe('malformed_request');
  });
});
