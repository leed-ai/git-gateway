// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { byteOrder, encodeContent, fromBase64, toBase64, utf8 } from '../../src/reference/bytes.ts';
import { steppingClock } from '../../src/reference/clock.ts';
import { parentDirectories } from '../../src/reference/file-map.ts';
import { appendIdempotencyTrailer, readIdempotencyTrailer } from '../../src/reference/trailer.ts';

describe('bytes', () => {
  it('round-trips base64 for every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
  });

  it('returns text only for valid UTF-8', () => {
    expect(encodeContent(utf8('héllo'), 'text')).toEqual({ encoding: 'text', content: 'héllo' });
    expect(encodeContent(new Uint8Array([0xff]), 'text')).toEqual({ encoding: 'base64', content: '/w==' });
    expect(encodeContent(utf8('hi'), 'base64')).toEqual({ encoding: 'base64', content: 'aGk=' });
  });

  it('keeps a leading byte-order mark in text', () => {
    expect(encodeContent(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), 'text').content).toBe('﻿a');
  });

  it('orders by UTF-8 bytes, not UTF-16 code units', () => {
    // U+FF5E is one UTF-16 unit above the surrogates, but its UTF-8 bytes sort before U+1F30D's.
    expect(['🌍', '～'].toSorted(byteOrder)).toEqual(['～', '🌍']);
    expect(['b', 'a/b', 'a'].toSorted(byteOrder)).toEqual(['a', 'a/b', 'b']);
  });
});

describe('trailer', () => {
  it('appends the key as the final paragraph and reads it back', () => {
    const message = appendIdempotencyTrailer('Subject\n\nBody\n\n', 'k-1');
    expect(message).toBe('Subject\n\nBody\n\nGateway-Idempotency-Key: k-1\n');
    expect(readIdempotencyTrailer(message)).toBe('k-1');
  });

  it('reads null when the last line is not a trailer', () => {
    expect(readIdempotencyTrailer('Gateway-Idempotency-Key: k\n\nmore')).toBeNull();
    expect(readIdempotencyTrailer('plain')).toBeNull();
  });
});

describe('steppingClock', () => {
  it('steps from the start time', () => {
    const clock = steppingClock('2026-01-01T00:00:00.000Z', 500);
    expect([clock(), clock()].map((d) => d.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.500Z',
    ]);
  });

  it('rejects an invalid start', () => {
    expect(() => steppingClock('not a date')).toThrow(RangeError);
  });
});

describe('parentDirectories', () => {
  it('lists every proper parent, shallowest first', () => {
    expect(parentDirectories('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(parentDirectories('top')).toEqual([]);
  });
});
