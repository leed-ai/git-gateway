// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import {
  ancestors,
  contains,
  mergeBase,
  walkHistory,
  type CommitLookup,
} from '../../src/reference/history.ts';
import type { Commit } from '../../src/schemas/commit.ts';

/** The id of the commit named by one letter: the letter repeated 40 times. */
const id = (name: string): string => name.repeat(40);
const sig = (date: string) => ({ name: 'T', email: 't@example.com', date });

/** A graph of commits named by one letter; ids are the letter repeated 40 times. */
function graph(spec: Record<string, { parents: string[]; date: string }>): CommitLookup {
  const commits = new Map<string, Commit>(
    Object.entries(spec).map(([name, { parents, date }]) => [
      id(name),
      {
        sha: id(name),
        tree: id('t'),
        parents: parents.map(id),
        author: sig(date),
        committer: sig(date),
        message: name,
        idempotencyKey: null,
      },
    ]),
  );
  return (sha) => commits.get(sha);
}

const T = (n: number): string => `2026-01-01T00:00:0${n}.000Z`;

describe('history', () => {
  // a ← b ← c (main);  a ← d (side);  e = merge(c, d)
  const lookup = graph({
    a: { parents: [], date: T(0) },
    b: { parents: ['a'], date: T(1) },
    c: { parents: ['b'], date: T(2) },
    d: { parents: ['a'], date: T(3) },
    e: { parents: ['c', 'd'], date: T(4) },
    f: { parents: [], date: T(5) },
  });

  it('collects ancestors including the start', () => {
    expect([...ancestors(lookup, id('c'))].toSorted()).toEqual([id('a'), id('b'), id('c')].toSorted());
  });

  it('knows that a commit contains itself and its ancestors only', () => {
    expect(contains(lookup, id('e'), id('d'))).toBe(true);
    expect(contains(lookup, id('c'), id('c'))).toBe(true);
    expect(contains(lookup, id('c'), id('d'))).toBe(false);
  });

  it('walks newest first with children before parents', () => {
    expect(walkHistory(lookup, id('e')).map((c) => c.message)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('keeps children before parents even when dates go backwards', () => {
    const skewedLookup = graph({
      a: { parents: [], date: T(9) },
      b: { parents: ['a'], date: T(1) },
    });
    expect(walkHistory(skewedLookup, id('b')).map((c) => c.message)).toEqual(['b', 'a']);
  });

  it('finds the merge base, and null for unrelated histories', () => {
    expect(mergeBase(lookup, id('c'), id('d'))).toBe(id('a'));
    expect(mergeBase(lookup, id('e'), id('c'))).toBe(id('c'));
    expect(mergeBase(lookup, id('c'), id('f'))).toBeNull();
  });

  it('picks one best base in criss-cross history, deterministically', () => {
    // x and y each merge both p and q: both p and q are best common ancestors; the newer (q) wins.
    const crissLookup = graph({
      r: { parents: [], date: T(0) },
      p: { parents: ['r'], date: T(1) },
      q: { parents: ['r'], date: T(2) },
      x: { parents: ['p', 'q'], date: T(3) },
      y: { parents: ['q', 'p'], date: T(4) },
    });
    expect(mergeBase(crissLookup, id('x'), id('y'))).toBe(id('q'));
    expect(mergeBase(crissLookup, id('y'), id('x'))).toBe(id('q'));
  });
});
