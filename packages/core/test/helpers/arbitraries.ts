// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';

import type { Packet } from '../../src/schemas/packet.ts';

/** Any packet, with payloads small enough to keep runs fast. */
export const arbitraryPacket: fc.Arbitrary<Packet> = fc.oneof(
  fc.uint8Array({ maxLength: 300 }).map((payload): Packet => ({ type: 'data', payload })),
  fc.constantFrom<Packet>({ type: 'flush' }, { type: 'delim' }, { type: 'response-end' }),
);

/** A 40-character lowercase hex object id. */
export const arbitrarySha: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''));

/** A short path over a tiny alphabet, so generated snapshots and actions collide often. */
export const arbitraryPath: fc.Arbitrary<string> = fc
  .array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'));

/** A small content string, so independently generated files are often equal. */
export const arbitraryContent: fc.Arbitrary<string> = fc.constantFrom('', 'x', 'y', 'z\n');

/** File paths with no path both a file and a parent directory of another. */
export function consistentPaths(paths: readonly string[]): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    const clashes = kept.some(
      (other) => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`),
    );
    if (!clashes) kept.push(path);
  }
  return kept;
}

/** A snapshot description: path → [content, executable]. */
export const arbitrarySnapshot: fc.Arbitrary<ReadonlyMap<string, readonly [string, boolean]>> = fc
  .array(fc.tuple(arbitraryPath, arbitraryContent, fc.boolean()), { maxLength: 8 })
  .map((files) => {
    const paths = new Set(consistentPaths(files.map(([path]) => path)));
    const snapshot = new Map<string, readonly [string, boolean]>();
    for (const [path, content, executable] of files) {
      if (paths.has(path) && !snapshot.has(path)) snapshot.set(path, [content, executable]);
    }
    return snapshot;
  });
