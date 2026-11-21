// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { isExactVersion, lowestVersionOf } from '../src/version-range.ts';

describe('isExactVersion', () => {
  it.each([' 4.6.7 ', '4.6.7', '=4.6.7', 'v1.0.0', '1.0.0-next.20261120', '1.0.0+build.1'])(
    'treats %s as exact',
    (spec) => {
      expect(isExactVersion(spec)).toBe(true);
    },
  );

  it.each([
    '^4',
    '^4.6.7',
    '~4.6.7',
    '>=4 <5',
    '4.x',
    '*',
    'workspace:*',
    'link:@leed-ai/x',
    'latest',
    '4',
    '4.6',
    '',
  ])('treats %s as a range', (spec) => {
    expect(isExactVersion(spec)).toBe(false);
  });

  it('treats every generated major.minor.patch as exact and its caret form as a range', () => {
    const version = fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)).map((parts) => parts.join('.'));
    fc.assert(
      fc.property(version, (v) => {
        expect(isExactVersion(v)).toBe(true);
        expect(isExactVersion(`^${v}`)).toBe(false);
      }),
    );
  });
});

describe('lowestVersionOf', () => {
  it('gives the floor of caret ranges', () => {
    expect(lowestVersionOf('^4')).toBe('4.0.0');
    expect(lowestVersionOf(' ^5 ')).toBe('5.0.0');
    expect(lowestVersionOf('^4.2')).toBe('4.2.0');
    expect(lowestVersionOf('^4.2.1')).toBe('4.2.1');
  });

  it('refuses anything that is not a single caret range', () => {
    expect(lowestVersionOf('^4 || ^5')).toBeUndefined();
    expect(lowestVersionOf('~4.2.0')).toBeUndefined();
    expect(lowestVersionOf('4.2.0')).toBeUndefined();
  });
});
