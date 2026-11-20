// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, expectGatewayError, expectStatus } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { branchFrom, filePaths, readText, requireHead, seedRepo, writeFiles } from './fixtures.ts';

const GROUP = 'syncBranch';
const SEED = { 'shared.md': 'base\n', 'other.md': 'other\n', 'keep.md': 'keep\n' };

/** Diverges `main` and `staging` from a common seed with one commit each; returns both heads. */
async function diverge(
  gateway: Parameters<BehaviourCase['run']>[0]['gateway'],
  repo: string,
  onMain: Record<string, string | null>,
  onStaging: Record<string, string | null>,
): Promise<{ base: string; main: string; staging: string }> {
  const base = await seedRepo(gateway, repo, SEED);
  const staging = await branchFrom(gateway, repo, 'main', 'staging', onStaging);
  const main = await writeFiles(gateway, repo, 'main', onMain);
  return { base: base.sha, main: main.sha, staging: staging.sha };
}

/** Every syncBranch shape: up to date, fast-forward, merge, conflict, and its refusals. */
export const syncCases: readonly BehaviourCase[] = [
  behaviourCase(GROUP, 'up_to_date when into already contains from', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const staging = await branchFrom(gateway, repo, 'main', 'staging', { 'new.md': 'n' });
    const output = await gateway.syncBranch({ repo, from: 'main', into: 'staging' });
    assertEqual(output, { status: 'up_to_date', head: staging.sha }, 'nothing to do');
  }),
  behaviourCase(GROUP, 'fast_forward when into has no commits of its own', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, SEED);
    await gateway.promote({ repo, from: 'main', into: 'staging', sha: seed.sha });
    const ahead = await writeFiles(gateway, repo, 'main', { 'new.md': 'n' });
    const output = await gateway.syncBranch({ repo, from: 'main', into: 'staging' });
    assertEqual(
      output,
      {
        status: 'fast_forward',
        refUpdate: { ref: 'refs/heads/staging', oldSha: seed.sha, newSha: ahead.sha },
      },
      'fast-forwarded',
    );
    assertEqual(await requireHead(gateway, repo, 'staging'), ahead.sha, 'staging moved');
  }),
  behaviourCase(GROUP, 'merged: changes on different paths are combined', async ({ gateway, repo }) => {
    const heads = await diverge(
      gateway,
      repo,
      { 'other.md': 'main\n', 'm.md': 'm' },
      { 'shared.md': 'staging\n', 'keep.md': null },
    );
    const merged = expectStatus(await gateway.syncBranch({ repo, from: 'main', into: 'staging' }), 'merged');
    assertEqual(merged.commit.parents, [heads.staging, heads.main], 'parents: into, then from');
    assertEqual(
      merged.refUpdate,
      { ref: 'refs/heads/staging', oldSha: heads.staging, newSha: merged.commit.sha },
      'ref',
    );
    assertEqual(
      await filePaths(gateway, repo, 'staging'),
      ['m.md', 'other.md', 'shared.md'],
      'deletion kept, addition taken',
    );
    assertEqual(await readText(gateway, repo, 'staging', 'other.md'), 'main\n', 'from-side change taken');
    assertEqual(await readText(gateway, repo, 'staging', 'shared.md'), 'staging\n', 'into-side change kept');
    assertEqual(await requireHead(gateway, repo, 'main'), heads.main, 'from is never moved');
  }),
  behaviourCase(GROUP, 'merged: the default message names both branches', async ({ gateway, repo }) => {
    await diverge(gateway, repo, { 'a.md': 'a' }, { 'b.md': 'b' });
    const merged = expectStatus(await gateway.syncBranch({ repo, from: 'main', into: 'staging' }), 'merged');
    assertTrue(merged.commit.message.startsWith("Merge branch 'main' into staging"), 'default message');
  }),
  behaviourCase(GROUP, 'merged: an explicit author and message are used', async ({ gateway, repo }) => {
    await diverge(gateway, repo, { 'a.md': 'a' }, { 'b.md': 'b' });
    const author = { name: 'Sync Bot', email: 'sync@example.com' };
    const output = await gateway.syncBranch({
      repo,
      from: 'main',
      into: 'staging',
      author,
      message: 'Sync now',
    });
    const { commit } = expectStatus(output, 'merged');
    assertEqual([commit.author.name, commit.committer.email], ['Sync Bot', 'sync@example.com'], 'author');
    assertTrue(commit.message.startsWith('Sync now'), 'message');
  }),
  behaviourCase(
    GROUP,
    'merged: the same change on both sides is not a conflict',
    async ({ gateway, repo }) => {
      await diverge(gateway, repo, { 'shared.md': 'same\n', 'a.md': 'a' }, { 'shared.md': 'same\n' });
      expectStatus(await gateway.syncBranch({ repo, from: 'main', into: 'staging' }), 'merged');
      assertEqual(await readText(gateway, repo, 'staging', 'shared.md'), 'same\n', 'agreed content');
    },
  ),
  behaviourCase(GROUP, 'conflict: a path changed differently on both sides', async ({ gateway, repo }) => {
    const heads = await diverge(
      gateway,
      repo,
      { 'shared.md': 'main\n', 'a.md': 'a' },
      { 'shared.md': 'staging\n' },
    );
    const output = await gateway.syncBranch({ repo, from: 'main', into: 'staging' });
    assertEqual(
      output,
      {
        status: 'conflict',
        paths: ['shared.md'],
        base: heads.base,
        fromHead: heads.main,
        intoHead: heads.staging,
      },
      'conflict reported',
    );
    assertEqual(await requireHead(gateway, repo, 'staging'), heads.staging, 'into unchanged');
  }),
  behaviourCase(GROUP, 'conflict: changed on one side, deleted on the other', async ({ gateway, repo }) => {
    await diverge(gateway, repo, { 'shared.md': null }, { 'shared.md': 'edited\n' });
    const output = expectStatus(
      await gateway.syncBranch({ repo, from: 'main', into: 'staging' }),
      'conflict',
    );
    assertEqual(output.paths, ['shared.md'], 'modify/delete conflict');
  }),
  behaviourCase(
    GROUP,
    'conflict: a file on one side, a directory on the other',
    async ({ gateway, repo }) => {
      await diverge(gateway, repo, { thing: 'file' }, { 'thing/inner.md': 'dir' });
      const output = expectStatus(
        await gateway.syncBranch({ repo, from: 'main', into: 'staging' }),
        'conflict',
      );
      assertTrue(output.paths.includes('thing'), 'file/directory conflict names the file');
    },
  ),
  behaviourCase(GROUP, 'syncing again after a merge is up_to_date', async ({ gateway, repo }) => {
    await diverge(gateway, repo, { 'a.md': 'a' }, { 'b.md': 'b' });
    const merged = expectStatus(await gateway.syncBranch({ repo, from: 'main', into: 'staging' }), 'merged');
    const again = await gateway.syncBranch({ repo, from: 'main', into: 'staging' });
    assertEqual(again, { status: 'up_to_date', head: merged.commit.sha }, 'idempotent');
  }),
  behaviourCase(GROUP, 'a missing branch is ref_not_found', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const error = await expectGatewayError(
      gateway.syncBranch({ repo, from: 'main', into: 'nope' }),
      'ref_not_found',
    );
    assertEqual(error.details.ref, 'nope', 'names the branch');
    await expectGatewayError(gateway.syncBranch({ repo, from: 'nope', into: 'main' }), 'ref_not_found');
  }),
  behaviourCase(GROUP, 'from and into must differ', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await expectGatewayError(gateway.syncBranch({ repo, from: 'main', into: 'main' }), 'invalid_input');
  }),
];
