// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { encodeReceivePackRequest } from '../../src/receive-pack/encode-request.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const ZERO = '0'.repeat(40);
const PACK = new TextEncoder().encode('PACK');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('encodeReceivePackRequest', () => {
  it('writes the commands with capabilities on the first, a flush, then the pack', () => {
    const body = encodeReceivePackRequest({
      commands: [
        { oldSha: A, newSha: B, ref: 'refs/heads/main' },
        { oldSha: ZERO, newSha: B, ref: 'refs/heads/new' },
      ],
      pack: PACK,
    });
    expect(text(body)).toBe(
      `0074${A} ${B} refs/heads/main\0report-status\n0065${ZERO} ${B} refs/heads/new\n0000PACK`,
    );
  });

  it('adds the push-options capability and section when options are given', () => {
    const body = text(
      encodeReceivePackRequest({
        commands: [{ oldSha: A, newSha: B, ref: 'refs/heads/main' }],
        capabilities: ['report-status', 'side-band-64k'],
        pushOptions: ['ci.skip'],
        pack: PACK,
      }),
    );
    expect(body).toContain('\0report-status side-band-64k push-options\n');
    expect(body.endsWith('0000000cci.skip\n0000PACK')).toBe(true);
  });

  it('does not repeat a push-options capability the caller already asked for', () => {
    const body = text(
      encodeReceivePackRequest({
        commands: [{ oldSha: A, newSha: B, ref: 'refs/heads/main' }],
        capabilities: ['push-options'],
        pushOptions: ['x'],
        pack: PACK,
      }),
    );
    expect(body.match(/push-options/g)).toHaveLength(1);
  });

  it('sends no pack for a push that only deletes refs', () => {
    const body = encodeReceivePackRequest({ commands: [{ oldSha: A, newSha: ZERO, ref: 'refs/heads/old' }] });
    expect(text(body).endsWith('refs/heads/old\0report-status\n0000')).toBe(true);
  });

  it('requires a pack when a command writes an object', () => {
    expect(() =>
      encodeReceivePackRequest({ commands: [{ oldSha: A, newSha: B, ref: 'refs/heads/main' }] }),
    ).toThrow(/pack is required/);
  });

  it('refuses an invalid command', () => {
    expect(() =>
      encodeReceivePackRequest({
        commands: [{ oldSha: 'abc', newSha: B, ref: 'refs/heads/main' }],
        pack: PACK,
      }),
    ).toThrow(ZodError);
    expect(() => encodeReceivePackRequest({ commands: [], pack: PACK })).toThrow(ZodError);
  });

  it('refuses two commands for the same ref', () => {
    expect(() =>
      encodeReceivePackRequest({
        commands: [
          { oldSha: A, newSha: B, ref: 'refs/heads/main' },
          { oldSha: B, newSha: A, ref: 'refs/heads/main' },
        ],
        pack: PACK,
      }),
    ).toThrow(/at most one command/);
  });
});
