// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue } from '@leed-ai/git-gateway-contract/behaviour/assertions';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { backendCase, type BackendCase } from './backend-case.ts';
import { fixtureCommit } from './backend-fixtures.ts';
import {
  expectAccepted,
  expectRefused,
  newObjects,
  pushNewBranch,
  pushRef,
  seedRepo,
} from './push-helpers.ts';

const GROUP = 'push semantics';
const MAIN = 'refs/heads/main';

/** Ref updates through receive-pack: stale heads, fast-forward, force, create and delete. */
export const pushCases: readonly BackendCase[] = [
  backendCase(GROUP, 'a fast-forward naming the current head is accepted', async (context) => {
    const first = await seedRepo(context);
    const second = await fixtureCommit({ 'README.md': '# Two\n' }, [first.sha]);
    expectAccepted(await pushRef(context, MAIN, first.sha, second.sha, newObjects(second, first)), MAIN);
    assertEqual(await context.backend.resolveRef(context.repo, 'main'), second.sha, 'main moved');
  }),
  backendCase(GROUP, 'an update naming a stale old id is refused and changes nothing', async (context) => {
    const first = await seedRepo(context);
    const second = await fixtureCommit({ 'README.md': '# Two\n' }, [first.sha]);
    expectAccepted(await pushRef(context, MAIN, first.sha, second.sha, second.objects), MAIN);
    // A writer that still believes main is at `first` builds on it and pushes.
    const stale = await fixtureCommit({ 'README.md': '# Stale\n' }, [first.sha]);
    expectRefused(await pushRef(context, MAIN, first.sha, stale.sha, stale.objects), MAIN);
    assertEqual(await context.backend.resolveRef(context.repo, 'main'), second.sha, 'main unchanged');
  }),
  backendCase(GROUP, 'creating a branch that already exists (old id zero) is refused', async (context) => {
    const first = await seedRepo(context);
    const other = await fixtureCommit({ 'other.txt': 'o\n' });
    expectRefused(await pushRef(context, MAIN, ZERO_SHA, other.sha, other.objects), MAIN);
    assertEqual(await context.backend.resolveRef(context.repo, 'main'), first.sha, 'main unchanged');
  }),
  backendCase(
    GROUP,
    'a non-fast-forward naming the current head follows the host behaviour',
    async (context) => {
      const first = await seedRepo(context);
      const base = await fixtureCommit({ 'f.txt': 'base\n' }, [first.sha]);
      await pushNewBranch(context, 'feature', base);
      const rewritten = await fixtureCommit({ 'f.txt': 'rewritten\n' }, [first.sha]);
      const report = await pushRef(
        context,
        'refs/heads/feature',
        base.sha,
        rewritten.sha,
        newObjects(rewritten, first),
      );
      const head = await context.backend.resolveRef(context.repo, 'feature');
      if (context.behaviour.nonFastForward === 'accepted') {
        expectAccepted(report, 'refs/heads/feature');
        assertEqual(head, rewritten.sha, 'feature rewritten');
      } else {
        expectRefused(report, 'refs/heads/feature');
        assertEqual(head, base.sha, 'feature unchanged');
      }
    },
  ),
  backendCase(
    GROUP,
    'a non-fast-forward naming a stale head is refused even when forced',
    async (context) => {
      const first = await seedRepo(context);
      const moved = await fixtureCommit({ 'README.md': '# Moved\n' }, [first.sha]);
      expectAccepted(await pushRef(context, MAIN, first.sha, moved.sha, moved.objects), MAIN);
      const unrelated = await fixtureCommit({ 'x.txt': 'unrelated\n' });
      expectRefused(await pushRef(context, MAIN, first.sha, unrelated.sha, unrelated.objects), MAIN);
      assertEqual(await context.backend.resolveRef(context.repo, 'main'), moved.sha, 'main unchanged');
    },
  ),
  backendCase(GROUP, 'a branch is deleted by a push naming its current head', async (context) => {
    const first = await seedRepo(context);
    const feature = await fixtureCommit({ 'f.txt': 'f\n' }, [first.sha]);
    await pushNewBranch(context, 'feature', feature);
    expectAccepted(await pushRef(context, 'refs/heads/feature', feature.sha, ZERO_SHA), 'refs/heads/feature');
    assertEqual(await context.backend.resolveRef(context.repo, 'feature'), null, 'feature gone');
    const refs = (await (await context.client('write')).advertisement('git-receive-pack')).refs.map(
      (ref) => ref.name,
    );
    assertTrue(!refs.includes('refs/heads/feature'), 'no longer advertised');
    assertEqual(await context.backend.resolveRef(context.repo, 'main'), first.sha, 'main untouched');
  }),
  backendCase(GROUP, 'a delete naming a stale head is refused', async (context) => {
    const first = await seedRepo(context);
    const feature = await fixtureCommit({ 'f.txt': 'f\n' }, [first.sha]);
    await pushNewBranch(context, 'feature', feature);
    expectRefused(await pushRef(context, 'refs/heads/feature', first.sha, ZERO_SHA), 'refs/heads/feature');
    assertEqual(await context.backend.resolveRef(context.repo, 'feature'), feature.sha, 'feature kept');
  }),
  backendCase(GROUP, 'a tag is created and deleted like a branch', async (context) => {
    const first = await seedRepo(context);
    expectAccepted(await pushRef(context, 'refs/tags/release', ZERO_SHA, first.sha), 'refs/tags/release');
    assertEqual(
      await context.backend.resolveRef(context.repo, 'refs/tags/release'),
      first.sha,
      'tag created',
    );
    expectAccepted(await pushRef(context, 'refs/tags/release', first.sha, ZERO_SHA), 'refs/tags/release');
    assertEqual(await context.backend.resolveRef(context.repo, 'refs/tags/release'), null, 'tag deleted');
  }),
  backendCase(GROUP, 'of two concurrent pushes from the same head exactly one wins', async (context) => {
    const first = await seedRepo(context);
    const left = await fixtureCommit({ 'README.md': '# Left\n' }, [first.sha]);
    const right = await fixtureCommit({ 'README.md': '# Right\n' }, [first.sha]);
    const reports = await Promise.all([
      pushRef(context, MAIN, first.sha, left.sha, left.objects),
      pushRef(context, MAIN, first.sha, right.sha, right.objects),
    ]);
    const winners = reports.filter((report) => report.refs.every((ref) => ref.status === 'ok'));
    assertEqual(winners.length, 1, 'exactly one push succeeded');
    const head = await context.backend.resolveRef(context.repo, 'main');
    assertTrue(head === left.sha || head === right.sha, 'main names the winner');
    assertEqual(head, winners[0] === reports[0] ? left.sha : right.sha, 'the winner is the one reported ok');
  }),
];
