// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { requiredClauses } from '../src/workflow-condition.ts';

describe('requiredClauses', () => {
  it('splits a conjunction into normalised clauses, flattening nested ones', () => {
    expect(requiredClauses("${{ a=='x' && (b != 'y' && c) }}")).toEqual(["a == 'x'", "b != 'y'", 'c']);
  });

  it('keeps a parenthesised disjunction as one clause', () => {
    expect(requiredClauses('a && (b || c)')).toEqual(['a', '(b || c)']);
  });

  it('strips parentheses that enclose the whole condition, but not separate groups', () => {
    expect(requiredClauses('((a && b))')).toEqual(['a', 'b']);
    expect(requiredClauses('(a) && (b)')).toEqual(['a', 'b']);
  });

  it('is undefined for a top-level disjunction', () => {
    expect(requiredClauses('a && b || c')).toBeUndefined();
    expect(requiredClauses('(a) || (b)')).toBeUndefined();
  });

  it('ignores operators inside string literals, doubled quotes included', () => {
    expect(requiredClauses("a == 'x || y' && b == 'it''s && so'")).toEqual([
      "a == 'x || y'",
      "b == 'it''s && so'",
    ]);
  });

  it('is undefined for unbalanced, empty or mixed text', () => {
    for (const condition of ['(a && b', 'a) && (b', "a == 'x", '', 'x ${{ a }}', '${{ a }} && ${{ b }}']) {
      expect(requiredClauses(condition)).toBeUndefined();
    }
  });
});
