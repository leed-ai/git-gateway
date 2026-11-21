// SPDX-License-Identifier: Apache-2.0
import type { CommitLookup } from '@leed-ai/git-gateway-contract/reference/history';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import * as fc from 'fast-check';

import type { CommitSource } from '../../src/rpc/commit-source.ts';

/** The id of commit number `index`: its number in hex, padded to 40 digits. */
export const shaOf = (index: number): string => index.toString(16).padStart(40, '0');

/** Commit `index`'s parents (as indices of earlier commits) and committer time in ms. */
export interface DagNode {
  readonly parents: readonly number[];
  readonly time: number;
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

/** The commits of a DAG, by id. */
export function dagCommits(nodes: readonly DagNode[]): Map<string, Commit> {
  return new Map(
    nodes.map((node, index) => {
      const signature = { name: 'T', email: 't@example.com', date: new Date(BASE + node.time).toISOString() };
      const commit: Commit = {
        sha: shaOf(index),
        tree: 'e'.repeat(40),
        parents: node.parents.map(shaOf),
        author: signature,
        committer: signature,
        message: `commit ${index}\n`,
        idempotencyKey: null,
      };
      return [commit.sha, commit];
    }),
  );
}

/** A commit source over a DAG that counts reads; it caches nothing, so every read is counted. */
export class CountingSource implements CommitSource {
  reads = 0;
  readonly #commits: Map<string, Commit>;

  constructor(commits: Map<string, Commit>) {
    this.#commits = commits;
  }

  async commit(sha: string): Promise<Commit | null> {
    this.reads += 1;
    return this.#commits.get(sha) ?? null;
  }

  /** A synchronous lookup for the reference functions. */
  lookup(): CommitLookup {
    return (sha) => this.#commits.get(sha);
  }
}

/**
 * Random DAGs of up to `max` commits: each commit's parents (none, one or two) are earlier
 * commits, so the graph is acyclic. With `monotone`, committer dates never decrease from parent
 * to child (ties are common); otherwise dates are arbitrary (clock skew).
 */
export function dagArbitrary(max: number, monotone: boolean): fc.Arbitrary<DagNode[]> {
  return fc
    .array(
      fc.record({
        parentPicks: fc.array(fc.nat(), { maxLength: 2 }),
        step: fc.constantFrom(0, 0, 1000, 1500, 60_000),
        skewed: fc.integer({ min: 0, max: 100_000 }),
      }),
      { minLength: 1, maxLength: max },
    )
    .map((raw) => {
      let time = 0;
      return raw.map(({ parentPicks, step, skewed }, index) => {
        time += step;
        const parents = index === 0 ? [] : [...new Set(parentPicks.map((pick) => pick % index))];
        return { parents, time: monotone ? time : skewed };
      });
    });
}

/** A linear history of `length` commits, one second apart; the head is the last. */
export function linearDag(length: number): DagNode[] {
  return Array.from({ length }, (_, index) => ({
    parents: index === 0 ? [] : [index - 1],
    time: index * 1000,
  }));
}
