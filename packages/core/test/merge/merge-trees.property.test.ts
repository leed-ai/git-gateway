// SPDX-License-Identifier: Apache-2.0
import { threeWayMerge } from '@leed-ai/git-gateway-contract/reference/three-way-merge';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { mergeTrees } from '../../src/merge/merge-trees.ts';
import type { TreeMergeResult } from '../../src/schemas/tree-merge.ts';
import { arbitrarySnapshot } from '../helpers/arbitraries.ts';
import { MemoryStore } from '../helpers/memory-store.ts';
import { fileMapSignature, flattenSignature, toFileMap, toSnapshot } from '../helpers/reference-model.ts';

type Description = ReadonlyMap<string, readonly [string, boolean]>;

/** A comparable merge outcome: merged files, or the conflicting paths. */
type Outcome = { files: Map<string, string> } | { conflicts: readonly string[] };

async function runMerge(base: Description, ours: Description, theirs: Description): Promise<Outcome> {
  const store = new MemoryStore();
  const [b, o, t] = [
    await store.writeSnapshot(toSnapshot(base)),
    await store.writeSnapshot(toSnapshot(ours)),
    await store.writeSnapshot(toSnapshot(theirs)),
  ];
  const result: TreeMergeResult = await mergeTrees({ base: b, ours: o, theirs: t }, store);
  if (result.status === 'conflict') return { conflicts: result.paths };
  store.put(result.objects);
  return { files: await flattenSignature(store, result.tree) };
}

/** Two sides derived from one base, so that they share most paths. */
const triple = arbitrarySnapshot.chain((base) => {
  const derive = arbitrarySnapshot.chain((extra) =>
    fc.subarray([...base.keys()]).map((dropped) => {
      const next = new Map(base);
      for (const path of dropped) next.delete(path);
      for (const [path, file] of extra) {
        const clash = [...next.keys()].some(
          (p) => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`),
        );
        if (!clash || next.has(path)) next.set(path, file);
      }
      return next;
    }),
  );
  return fc.tuple(fc.constant(base), derive, derive);
});

const RUNS = { numRuns: 300 };

/** A side's file at a path in comparable form. */
const key = (side: Description, path: string): string => JSON.stringify(side.get(path) ?? null);

describe('mergeTrees properties', () => {
  it('agrees with the contract reference merge on every input', async () => {
    await fc.assert(
      fc.asyncProperty(triple, async ([base, ours, theirs]) => {
        const reference = threeWayMerge(
          await toFileMap(base),
          await toFileMap(ours),
          await toFileMap(theirs),
        );
        const expected: Outcome =
          reference.kind === 'conflict'
            ? { conflicts: reference.paths }
            : { files: fileMapSignature(reference.files) };
        expect(await runMerge(base, ours, theirs)).toEqual(expected);
      }),
      RUNS,
    );
  });

  it('is commutative: swapping the sides gives the same outcome', async () => {
    await fc.assert(
      fc.asyncProperty(triple, async ([base, ours, theirs]) => {
        expect(await runMerge(base, theirs, ours)).toEqual(await runMerge(base, ours, theirs));
      }),
      RUNS,
    );
  });

  it('conflicts on a path changed differently on both sides, and never loses a one-sided change', async () => {
    await fc.assert(
      fc.asyncProperty(triple, async ([base, ours, theirs]) => {
        const outcome = await runMerge(base, ours, theirs);
        const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
        for (const path of paths) {
          const [b, o, t] = [key(base, path), key(ours, path), key(theirs, path)];
          const bothChanged = o !== b && t !== b && o !== t;
          const conflicts = 'conflicts' in outcome ? outcome.conflicts : [];
          expect(!bothChanged || conflicts.includes(path)).toBe(true);
          const merged = 'files' in outcome ? outcome.files.get(path) : undefined;
          const want = o !== b ? ours.get(path) : t !== b ? theirs.get(path) : base.get(path);
          expect('conflicts' in outcome || (merged === undefined) === (want === undefined)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('merges cleanly when the sides touch disjoint paths', async () => {
    await fc.assert(
      fc.asyncProperty(arbitrarySnapshot, async (base) => {
        const paths = [...base.keys()];
        const ours = new Map(base);
        const theirs = new Map(base);
        paths.forEach((path, index) => {
          const side = index % 2 === 0 ? ours : theirs;
          side.set(path, ['changed', false]);
        });
        const outcome = await runMerge(base, ours, theirs);
        expect('files' in outcome && [...outcome.files.keys()].toSorted()).toEqual(paths.toSorted());
      }),
      RUNS,
    );
  });
});
