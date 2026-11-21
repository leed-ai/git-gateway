// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { gitBinary, isAtLeast, parseGitVersion } from '../src/git-binary.ts';

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.43.0', { major: 2, minor: 43, patch: 0, raw: '2.43.0' }],
    [
      'git version 2.39.5 (Apple Git-154)\n',
      { major: 2, minor: 39, patch: 5, raw: '2.39.5 (Apple Git-154)' },
    ],
    ['git version 2.47.1.windows.2', { major: 2, minor: 47, patch: 1, raw: '2.47.1.windows.2' }],
    ['git version 2.50', { major: 2, minor: 50, patch: 0, raw: '2.50' }],
  ])('parses %j', (output, expected) => {
    expect(parseGitVersion(output)).toEqual(expected);
  });

  it.each(['', 'hub version 2.14.2', 'git version', 'git version two'])('rejects %j', (output) => {
    expect(() => parseGitVersion(output)).toThrow(/not a git --version line/);
  });

  it('round-trips any major.minor.patch', () => {
    fc.assert(
      fc.property(fc.nat(99), fc.nat(999), fc.nat(99), (major, minor, patch) => {
        expect(parseGitVersion(`git version ${major}.${minor}.${patch}`)).toEqual({
          major,
          minor,
          patch,
          raw: `${major}.${minor}.${patch}`,
        });
      }),
    );
  });
});

describe('gitBinary', () => {
  it('uses GIT_BINARY when set and git otherwise', () => {
    expect(gitBinary({ GIT_BINARY: '/opt/git/2.34.1/bin/git' })).toBe('/opt/git/2.34.1/bin/git');
    expect(gitBinary({ GIT_BINARY: '  ' })).toBe('git');
    expect(gitBinary({})).toBe('git');
  });
});

describe('isAtLeast', () => {
  const version = parseGitVersion('git version 2.43.1');
  it('compares major, then minor, then patch', () => {
    expect(isAtLeast(version, 2, 43, 1)).toBe(true);
    expect(isAtLeast(version, 2, 43)).toBe(true);
    expect(isAtLeast(version, 2, 43, 2)).toBe(false);
    expect(isAtLeast(version, 2, 44)).toBe(false);
    expect(isAtLeast(version, 1, 99, 99)).toBe(true);
    expect(isAtLeast(version, 3, 0)).toBe(false);
  });

  it('agrees with lexicographic comparison of version tuples', () => {
    const triple = fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9));
    fc.assert(
      fc.property(triple, triple, ([a, b, c], [x, y, z]) => {
        const lexicographic = a !== x ? a > x : b !== y ? b > y : c >= z;
        expect(isAtLeast({ major: a, minor: b, patch: c, raw: `${a}.${b}.${c}` }, x, y, z)).toBe(
          lexicographic,
        );
      }),
    );
  });
});
