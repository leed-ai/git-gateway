// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { concatBytes, hexToBytes } from '../../src/bytes.ts';
import { isCoreError } from '../../src/core-error.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { compareTreeEntries, decodeTree, encodeTree } from '../../src/objects/tree-object.ts';
import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import { arbitrarySha } from '../helpers/arbitraries.ts';

const EMPTY = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a';
const SCRIPT = '4163036efa65bd4a469e752267498f01ea36a55c';
const AB = '5c7796f622a1e15babe6f341a239b0de7af1ba49';
const INNER = 'c3fe1f0484edb75ca3c4c5e49ba19d820c84c179';

/** Built with `git mktree` (git 2.43) from these entries; the order here is deliberately not git's. */
const FIXTURE: GitTreeEntry[] = [
  { name: 'hello.txt', mode: '100644', sha: HELLO },
  { name: 'run.sh', mode: '100755', sha: SCRIPT },
  { name: 'a', mode: '040000', sha: INNER },
  { name: 'a-b', mode: '100644', sha: AB },
  { name: 'a.b', mode: '100644', sha: EMPTY },
  { name: 'link', mode: '120000', sha: AB },
];
const FIXTURE_SHA = 'ca2954efa39bbe2b06603870092b566af10a9f4e';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const names = (entries: GitTreeEntry[]): string[] => entries.toSorted(compareTreeEntries).map((e) => e.name);

function invalidReason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (isCoreError(error, 'invalid_object') && error.body.code === 'invalid_object') {
      return error.body.details.reason;
    }
    throw error;
  }
  return undefined;
}

describe('encodeTree', () => {
  it('hashes identically to git mktree', async () => {
    expect(await hashObject('tree', encodeTree(FIXTURE))).toBe(FIXTURE_SHA);
  });

  it('writes a directory mode without its leading zero', () => {
    const encoded = encodeTree([{ name: 'a', mode: '040000', sha: INNER }]);
    expect(encoded).toEqual(concatBytes([bytes('40000 a\0'), hexToBytes(INNER)]));
  });

  it('hashes an inner tree identically to git', async () => {
    expect(await hashObject('tree', encodeTree([{ name: 'x.txt', mode: '100644', sha: EMPTY }]))).toBe(INNER);
  });

  it('sorts a subtree as if its name ended in "/"', () => {
    expect(names(FIXTURE)).toEqual(['a-b', 'a.b', 'a', 'hello.txt', 'link', 'run.sh']);
    const fileA = { name: 'a', mode: '100644', sha: EMPTY } as const;
    expect(names([{ name: 'a-b', mode: '100644', sha: EMPTY }, fileA])).toEqual(['a', 'a-b']);
  });

  it('sorts by UTF-8 bytes, not UTF-16 code units', () => {
    const entries: GitTreeEntry[] = [
      { name: '\u{1F600}', mode: '100644', sha: EMPTY },
      { name: '～', mode: '100644', sha: EMPTY },
    ];
    expect(entries.toSorted(compareTreeEntries).map((e) => e.name)).toEqual(['～', '\u{1F600}']);
  });

  it.each(['.', '..', '.git', '.GIT'])('refuses the reserved name %s', (name) => {
    expect(invalidReason(() => encodeTree([{ name, mode: '100644', sha: EMPTY }]))).toMatch(/reserved/);
  });

  it('refuses duplicate names', () => {
    const entry = { name: 'x', mode: '100644', sha: EMPTY } as const;
    expect(invalidReason(() => encodeTree([entry, { ...entry, mode: '040000' }]))).toMatch(/duplicate/);
  });

  it('refuses entries that are not entries', () => {
    expect(() => encodeTree([{ name: 'a/b', mode: '100644', sha: EMPTY }])).toThrow(ZodError);
  });

  it('encodes the empty tree as no bytes', () => {
    expect(encodeTree([])).toEqual(new Uint8Array(0));
  });
});

describe('decodeTree', () => {
  it('round-trips any entry list in git order', () => {
    const entry = fc.record({
      name: fc
        .stringMatching(/^[a-zA-Z0-9._\-é ]{1,12}$/)
        .filter((n) => !['.', '..', '.git'].includes(n.toLowerCase())),
      mode: fc.constantFrom('100644', '100755', '120000', '040000', '160000'),
      sha: arbitrarySha,
    }) as fc.Arbitrary<GitTreeEntry>;
    fc.assert(
      fc.property(fc.uniqueArray(entry, { selector: (e) => e.name, maxLength: 10 }), (entries) => {
        expect(decodeTree(encodeTree(entries))).toEqual(entries.toSorted(compareTreeEntries));
      }),
    );
  });

  it('decodes the git fixture', () => {
    expect(decodeTree(encodeTree(FIXTURE), FIXTURE_SHA).map((e) => e.name)).toEqual([
      'a-b',
      'a.b',
      'a',
      'hello.txt',
      'link',
      'run.sh',
    ]);
  });

  it.each([
    ['a truncated id', concatBytes([bytes('100644 a\0'), new Uint8Array(19)]), /truncated/],
    ['a missing NUL', bytes('100644 abc'), /truncated/],
    ['a missing space', bytes('100644'), /truncated/],
    ['an unknown mode', concatBytes([bytes('100664 a\0'), new Uint8Array(20)]), /unknown mode 100664/],
    [
      'a name that is not UTF-8',
      concatBytes([bytes('100644 '), Uint8Array.of(0xff), bytes('\0'), new Uint8Array(20)]),
      /UTF-8/,
    ],
    ['an empty name', concatBytes([bytes('100644 \0'), new Uint8Array(20)]), /bad entry name/],
  ])('refuses %s', (_, data, reason) => {
    expect(invalidReason(() => decodeTree(data))).toMatch(reason);
  });
});
