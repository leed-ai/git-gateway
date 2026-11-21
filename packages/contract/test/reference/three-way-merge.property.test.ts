// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import type { FileMap, StoredFile } from '../../src/reference/file-map.ts';
import { threeWayMerge, type MergeResult } from '../../src/reference/three-way-merge.ts';

const PATHS = ['a', 'b', 'c', 'd/e', 'd/f'] as const;
const file = (version: number, executable = false): StoredFile => ({
  bytes: new Uint8Array([version]),
  executable,
  sha: `v${version}${executable ? 'x' : ''}`,
});

/** One side's version of each path in {@link PATHS}: undefined = absent. */
type Side = readonly (number | undefined)[];
const side = fc.array(fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }), {
  minLength: PATHS.length,
  maxLength: PATHS.length,
});

const toMap = (versions: Side): FileMap =>
  new Map(
    PATHS.flatMap((path, index) => {
      const version = versions[index];
      return version === undefined ? [] : [[path, file(version)] as const];
    }),
  );

/** The merged path → blob id map, or null on conflict. */
const shas = (result: MergeResult): Map<string, string> | null =>
  result.kind === 'merged' ? new Map([...result.files].map(([path, f]) => [path, f.sha])) : null;
const conflicts = (result: MergeResult): readonly string[] =>
  result.kind === 'conflict' ? result.paths : [];
const merge = (b: Side, o: Side, t: Side): MergeResult => threeWayMerge(toMap(b), toMap(o), toMap(t));

describe('threeWayMerge (property)', () => {
  it('conflicts exactly on paths changed differently on both sides', () => {
    fc.assert(
      fc.property(side, side, side, (b, o, t) => {
        const expected = PATHS.filter((_, i) => o[i] !== b[i] && t[i] !== b[i] && o[i] !== t[i]);
        expect(conflicts(merge(b, o, t))).toEqual(expected);
      }),
    );
  });

  it('is commutative', () => {
    fc.assert(
      fc.property(side, side, side, (b, o, t) => {
        const left = merge(b, o, t);
        const right = merge(b, t, o);
        expect(shas(left)).toEqual(shas(right));
        expect(conflicts(left)).toEqual(conflicts(right));
      }),
    );
  });

  it('never loses a one-sided change', () => {
    fc.assert(
      fc.property(side, side, side, (b, o, t) => {
        const merged = shas(merge(b, o, t)) ?? new Map<string, string>();
        const hasConflict = merged.size === 0 && conflicts(merge(b, o, t)).length > 0;
        const expected = new Map<string, string | undefined>();
        PATHS.forEach((path, i) => {
          if (o[i] !== b[i] && t[i] === b[i]) expected.set(path, toMap(o).get(path)?.sha);
          if (t[i] !== b[i] && o[i] === b[i]) expected.set(path, toMap(t).get(path)?.sha);
        });
        const actual = new Map(
          [...expected.keys()].map((path) => [path, hasConflict ? expected.get(path) : merged.get(path)]),
        );
        expect(actual).toEqual(expected);
      }),
    );
  });

  it('merging a side with itself, or with the base, gives that side', () => {
    fc.assert(
      fc.property(side, side, (b, o) => {
        const expected = new Map([...toMap(o)].map(([path, f]) => [path, f.sha]));
        expect(shas(merge(b, o, o))).toEqual(expected);
        expect(shas(merge(b, o, b))).toEqual(expected);
      }),
    );
  });

  it('treats a mode change as a change', () => {
    const base = new Map([['a', file(1)]]);
    const result = threeWayMerge(base, new Map([['a', file(1, true)]]), new Map([['a', file(2)]]));
    expect(result).toEqual({ kind: 'conflict', paths: ['a'] });
  });

  it('reports a file on one side against a directory on the other', () => {
    const result = threeWayMerge(new Map(), new Map([['x', file(1)]]), new Map([['x/y', file(2)]]));
    expect(result).toEqual({ kind: 'conflict', paths: ['x', 'x/y'] });
  });
});
