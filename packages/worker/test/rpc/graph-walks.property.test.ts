// SPDX-License-Identifier: Apache-2.0
import { contains, mergeBase, walkHistory } from '@leed-ai/git-gateway-contract/reference/history';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { historyPage } from '../../src/rpc/history-page.ts';
import { isAncestor, mergeBaseOf } from '../../src/rpc/paint-down.ts';
import {
  CountingSource,
  dagArbitrary,
  dagCommits,
  linearDag,
  shaOf,
  type DagNode,
} from '../helpers/commit-dag.ts';

/** A DAG with two of its commits picked out. */
const dagWithPair = (monotone: boolean) =>
  dagArbitrary(30, monotone).chain((nodes) =>
    fc.record({
      nodes: fc.constant(nodes),
      a: fc.nat({ max: nodes.length - 1 }),
      b: fc.nat({ max: nodes.length - 1 }),
    }),
  );

const sourceOf = (nodes: readonly DagNode[]) => new CountingSource(dagCommits(nodes));

describe('paint-down ancestry against the reference', () => {
  for (const monotone of [true, false]) {
    const dates = monotone ? 'ordered dates' : 'skewed dates';

    it(`isAncestor agrees with contains (${dates})`, async () => {
      await fc.assert(
        fc.asyncProperty(dagWithPair(monotone), async ({ nodes, a, b }) => {
          const source = sourceOf(nodes);
          expect(await isAncestor(source, shaOf(a), shaOf(b))).toBe(
            contains(source.lookup(), shaOf(a), shaOf(b)),
          );
        }),
        { numRuns: 300 },
      );
    });

    it(`mergeBaseOf agrees with mergeBase, criss-cross included (${dates})`, async () => {
      await fc.assert(
        fc.asyncProperty(dagWithPair(monotone), async ({ nodes, a, b }) => {
          const source = sourceOf(nodes);
          expect(await mergeBaseOf(source, shaOf(a), shaOf(b))).toBe(
            mergeBase(source.lookup(), shaOf(a), shaOf(b)),
          );
        }),
        { numRuns: 300 },
      );
    });
  }

  it('answers false for a missing commit, as the reference does', async () => {
    const source = sourceOf(linearDag(3));
    expect(await isAncestor(source, shaOf(2), 'f'.repeat(40))).toBe(false);
    expect(await isAncestor(source, 'f'.repeat(40), 'f'.repeat(40))).toBe(false);
    expect(await mergeBaseOf(source, shaOf(2), 'f'.repeat(40))).toBeNull();
  });
});

const expected = (
  source: CountingSource,
  head: string,
  request: { limit: number; offset: number; since?: string | undefined },
) => {
  const lowest = request.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.since);
  const history = walkHistory(source.lookup(), head).filter(
    (commit) => Date.parse(commit.committer.date) >= lowest,
  );
  return {
    commits: history.slice(request.offset, request.offset + request.limit),
    hasMore: history.length > request.offset + request.limit,
  };
};

const sinceOf = (at: number | undefined) =>
  at === undefined ? undefined : new Date(Date.parse('2026-01-01T00:00:00.000Z') + at).toISOString();

describe('bounded log against the reference', () => {
  const page = fc.record({
    limit: fc.integer({ min: 1, max: 12 }),
    offset: fc.integer({ min: 0, max: 12 }),
    sinceAt: fc.option(fc.nat({ max: 200_000 }), { nil: undefined }),
  });

  it('lists exactly the reference page while dates never decrease from parent to child', async () => {
    await fc.assert(
      fc.asyncProperty(
        dagArbitrary(40, true),
        page,
        fc.nat(),
        async (nodes, { limit, offset, sinceAt }, pick) => {
          const source = sourceOf(nodes);
          const head = shaOf(pick % nodes.length);
          const start = source.lookup()(head);
          if (start === undefined) throw new Error('missing head');
          const request = { limit, offset, since: sinceOf(sinceAt) };
          expect(await historyPage(source, start, request)).toEqual(expected(source, head, request));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('falls back to the full reference order when it meets clock skew', async () => {
    await fc.assert(
      fc.asyncProperty(dagArbitrary(40, false), fc.nat(), async (nodes, pick) => {
        const source = sourceOf(nodes);
        const head = shaOf(pick % nodes.length);
        const start = source.lookup()(head);
        if (start === undefined) throw new Error('missing head');
        // A page as long as the history reads every edge, so any skew is met.
        const request = { limit: nodes.length, offset: 0 };
        expect(await historyPage(source, start, request)).toEqual(expected(source, head, request));
      }),
      { numRuns: 300 },
    );
  });

  it('orders a skewed parent after its child', async () => {
    // 0 ← 1 ← 2, where 1 is dated before its parent 0.
    const nodes = [
      { parents: [], time: 5000 },
      { parents: [0], time: 1000 },
      { parents: [1], time: 9000 },
    ];
    const source = sourceOf(nodes);
    const start = source.lookup()(shaOf(2));
    if (start === undefined) throw new Error('missing head');
    const { commits } = await historyPage(source, start, { limit: 3, offset: 0 });
    expect(commits.map((commit) => commit.sha)).toEqual([shaOf(2), shaOf(1), shaOf(0)]);
  });
});

describe('reads stay bounded on a 1,000-commit history', () => {
  const LENGTH = 1000;
  const head = shaOf(LENGTH - 1);

  it('log({limit: 10}) reads about a page of commits, not the history', async () => {
    const source = sourceOf(linearDag(LENGTH));
    const start = await source.commit(head);
    if (start === null) throw new Error('missing head');
    source.reads = 0;
    const { commits, hasMore } = await historyPage(source, start, { limit: 10, offset: 0 });
    expect(commits).toHaveLength(10);
    expect(hasMore).toBe(true);
    expect(source.reads).toBeLessThanOrEqual(12);
  });

  it('log with since stops once the rest is older', async () => {
    const source = sourceOf(linearDag(LENGTH));
    const start = await source.commit(head);
    if (start === null) throw new Error('missing head');
    source.reads = 0;
    const since = new Date(Date.parse('2026-01-01T00:00:00.000Z') + (LENGTH - 5) * 1000).toISOString();
    const { commits, hasMore } = await historyPage(source, start, { limit: 50, offset: 0, since });
    expect(commits).toHaveLength(5);
    expect(hasMore).toBe(false);
    expect(source.reads).toBeLessThanOrEqual(8);
  });

  it('a merge base near the heads is found without walking the history', async () => {
    // A 1,000-commit trunk, then two branches of 3 commits each off its head.
    const nodes: DagNode[] = linearDag(LENGTH);
    const fork = LENGTH - 1;
    nodes.push({ parents: [fork], time: LENGTH * 1000 });
    nodes.push({ parents: [LENGTH], time: (LENGTH + 1) * 1000 });
    nodes.push({ parents: [LENGTH + 1], time: (LENGTH + 2) * 1000 });
    nodes.push({ parents: [fork], time: LENGTH * 1000 + 500 });
    nodes.push({ parents: [LENGTH + 3], time: (LENGTH + 1) * 1000 + 500 });
    nodes.push({ parents: [LENGTH + 4], time: (LENGTH + 2) * 1000 + 500 });
    const source = sourceOf(nodes);
    expect(await mergeBaseOf(source, shaOf(LENGTH + 2), shaOf(LENGTH + 5))).toBe(shaOf(fork));
    expect(source.reads).toBeLessThanOrEqual(20);
    source.reads = 0;
    // Neither branch contains the other: the answer is false, still without walking the trunk.
    expect(await isAncestor(source, shaOf(LENGTH + 2), shaOf(LENGTH + 5))).toBe(false);
    expect(source.reads).toBeLessThanOrEqual(20);
    source.reads = 0;
    expect(await isAncestor(source, shaOf(LENGTH + 2), shaOf(fork))).toBe(true);
    expect(source.reads).toBeLessThanOrEqual(20);
  });
});
