// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { compileRefPattern } from '../src/policy/ref-pattern.ts';

/** A reference glob matcher written independently: recursive descent over pattern and ref. */
function naiveMatch(pattern: string, ref: string): boolean {
  if (pattern === '') return ref === '';
  if (pattern.startsWith('**')) {
    for (let index = 0; index <= ref.length; index += 1)
      if (naiveMatch(pattern.slice(2), ref.slice(index))) return true;
    return false;
  }
  if (pattern.startsWith('*')) {
    for (let index = 0; index <= ref.length; index += 1) {
      if (ref.slice(0, index).includes('/')) break;
      if (naiveMatch(pattern.slice(1), ref.slice(index))) return true;
    }
    return false;
  }
  return ref.startsWith(pattern[0] ?? '') && naiveMatch(pattern.slice(1), ref.slice(1));
}

describe('compileRefPattern', () => {
  it.each([
    ['refs/heads/main', 'refs/heads/main', true],
    ['refs/heads/main', 'refs/heads/main2', false],
    ['refs/heads/release/*', 'refs/heads/release/1.0', true],
    ['refs/heads/release/*', 'refs/heads/release/1.0/hotfix', false],
    ['refs/heads/**', 'refs/heads/a/b/c', true],
    ['refs/tags/v*', 'refs/tags/v1.2.3', true],
    ['refs/tags/v*', 'refs/heads/v1', false],
    ['refs/heads/a.b', 'refs/heads/aXb', false],
    ['refs/heads/feature/**', 'refs/heads/feature/x', true],
  ])('%s matches %s: %s', (pattern, ref, expected) => {
    expect(compileRefPattern(pattern)(ref)).toBe(expected);
  });

  it('rejects patterns the schema does not allow', () => {
    expect(() => compileRefPattern('refs/notes/*')).toThrow(/Invalid string/);
    expect(() => compileRefPattern('refs/heads/a/../b')).toThrow(/Invalid string/);
    expect(() => compileRefPattern('refs/heads/***')).toThrow(/Invalid string/);
  });

  it('agrees with a naive glob matcher (property)', () => {
    const segment = fc
      .stringMatching(/^[ab.*]{1,4}$/)
      .filter((text) => !text.includes('***') && !text.includes('..'));
    const pattern = fc
      .array(segment, { minLength: 1, maxLength: 3 })
      .map((parts) => `refs/heads/${parts.join('/')}`);
    const ref = fc
      .array(fc.stringMatching(/^[ab.]{1,4}$/), { minLength: 1, maxLength: 4 })
      .map((parts) => `refs/heads/${parts.join('/')}`);
    fc.assert(
      fc.property(pattern, ref, (glob, name) => {
        expect(compileRefPattern(glob)(name)).toBe(naiveMatch(glob, name));
      }),
      { numRuns: 500 },
    );
  });
});
