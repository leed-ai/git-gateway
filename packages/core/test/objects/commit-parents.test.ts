// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { commitHeaderLines, readCommitParents } from '../../src/objects/commit-parents.ts';

const TREE = 'ca2954efa39bbe2b06603870092b566af10a9f4e';
const P1 = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const P2 = 'ffffffffffffffffffffffffffffffffffffffff';
const IDENT = 'Ada <a@b.co> 1 +0000';

describe('commitHeaderLines', () => {
  it('returns the lines before the first blank line, or every line when there is none', () => {
    expect(commitHeaderLines(`tree ${TREE}\nauthor ${IDENT}\n\nbody\n\nmore`)).toEqual([
      `tree ${TREE}`,
      `author ${IDENT}`,
    ]);
    expect(commitHeaderLines(`tree ${TREE}\nauthor ${IDENT}`)).toEqual([`tree ${TREE}`, `author ${IDENT}`]);
  });
});

describe('readCommitParents', () => {
  it('reads the parent lines straight after the tree, in order', () => {
    expect(readCommitParents([`tree ${TREE}`, `author ${IDENT}`])).toEqual([]);
    expect(readCommitParents([`tree ${TREE}`, `parent ${P1}`, `parent ${P2}`, `author ${IDENT}`])).toEqual([
      P1,
      P2,
    ]);
  });

  it('ignores continuation lines that mention parent', () => {
    expect(readCommitParents([`tree ${TREE}`, `parent ${P1}`, 'gpgsig x', ` parent ${P2}`])).toEqual([P1]);
  });

  it.each([
    ['no tree line first', [`parent ${P1}`, `tree ${TREE}`]],
    ['a malformed tree line', [`tree ${TREE.slice(1)}`]],
    ['an empty header', []],
    ['a malformed parent line in the run', [`tree ${TREE}`, `parent ${P1.toUpperCase()}`]],
    ['a parent after the author', [`tree ${TREE}`, `author ${IDENT}`, `parent ${P1}`]],
    [
      'a parent after the committer, behind real parents',
      [`tree ${TREE}`, `parent ${P1}`, `committer ${IDENT}`, `parent ${P2}`],
    ],
  ])('refuses %s', (_label, lines) => {
    expect(readCommitParents(lines)).toBeNull();
  });

  it('never reports a parent git would not read (property)', () => {
    const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
    const line = fc.oneof(
      sha.map((value) => `parent ${value}`),
      fc.constant(`author ${IDENT}`),
      fc.constant(`committer ${IDENT}`),
      fc.constant('encoding UTF-8'),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), (rest) => {
        const lines = [`tree ${TREE}`, ...rest];
        const parents = readCommitParents(lines);
        const run = rest.findIndex((entry) => !entry.startsWith('parent '));
        const leading = run === -1 ? rest : rest.slice(0, run);
        const misplaced = run !== -1 && rest.slice(run).some((entry) => entry.startsWith('parent '));
        expect(parents).toEqual(misplaced ? null : leading.map((entry) => entry.slice(7)));
      }),
    );
  });
});
