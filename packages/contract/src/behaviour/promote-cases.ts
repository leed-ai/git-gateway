// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '../schemas/sha.ts';
import { assertEqual, expectGatewayError } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { branchFrom, requireHead, seedRepo, writeFiles } from './fixtures.ts';

const GROUP = 'promote';

/** promote fast-forwards from the source head only, and every refusal. */
export const promoteCases: readonly BehaviourCase[] = [
  behaviourCase(
    GROUP,
    'promotes the source head when it contains the target head',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo);
      const staging = await branchFrom(gateway, repo, 'main', 'staging', { 'new.md': 'n' });
      const output = await gateway.promote({ repo, from: 'staging', into: 'main', sha: staging.sha });
      assertEqual(
        output,
        { status: 'promoted', refUpdate: { ref: 'refs/heads/main', oldSha: seed.sha, newSha: staging.sha } },
        'fast-forwarded',
      );
      assertEqual(await requireHead(gateway, repo, 'main'), staging.sha, 'main moved');
    },
  ),
  behaviourCase(GROUP, 'up_to_date when the target already points at sha', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    await gateway.promote({ repo, from: 'main', into: 'production', sha: seed.sha });
    const output = await gateway.promote({ repo, from: 'main', into: 'production', sha: seed.sha });
    assertEqual(output, { status: 'up_to_date', head: seed.sha }, 'nothing to do');
  }),
  behaviourCase(GROUP, 'a missing target branch is created at sha', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const output = await gateway.promote({ repo, from: 'main', into: 'production', sha: seed.sha });
    assertEqual(
      output,
      { status: 'promoted', refUpdate: { ref: 'refs/heads/production', oldSha: ZERO_SHA, newSha: seed.sha } },
      'created',
    );
  }),
  behaviourCase(GROUP, 'refuses a sha that is not the source head', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const staging = await branchFrom(gateway, repo, 'main', 'staging', { 'a.md': 'a' });
    const newer = await writeFiles(gateway, repo, 'staging', { 'b.md': 'b' });
    const error = await expectGatewayError(
      gateway.promote({ repo, from: 'staging', into: 'main', sha: staging.sha }),
      'not_head_of_source',
    );
    assertEqual(error.details, { from: 'staging', sha: staging.sha, head: newer.sha }, 'details');
    assertEqual(await requireHead(gateway, repo, 'main'), seed.sha, 'main unchanged');
  }),
  behaviourCase(GROUP, 'refuses an unknown sha as not_head_of_source', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    await branchFrom(gateway, repo, 'main', 'staging', { 'a.md': 'a' });
    const sha = 'ffffffffffffffffffffffffffffffffffffffff';
    await expectGatewayError(
      gateway.promote({ repo, from: 'staging', into: 'main', sha }),
      'not_head_of_source',
    );
  }),
  behaviourCase(GROUP, 'refuses a non-fast-forward and never merges', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const staging = await branchFrom(gateway, repo, 'main', 'staging', { 'a.md': 'a' });
    const hotfix = await writeFiles(gateway, repo, 'main', { 'hotfix.md': 'h' });
    const error = await expectGatewayError(
      gateway.promote({ repo, from: 'staging', into: 'main', sha: staging.sha }),
      'not_fast_forward',
    );
    assertEqual(error.details, { into: 'main', sha: staging.sha, head: hotfix.sha }, 'details');
    assertEqual(await requireHead(gateway, repo, 'main'), hotfix.sha, 'main unchanged');
    assertEqual(await requireHead(gateway, repo, 'staging'), staging.sha, 'staging unchanged');
  }),
  behaviourCase(GROUP, 'a missing source branch is ref_not_found', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const call = gateway.promote({ repo, from: 'staging', into: 'main', sha: seed.sha });
    assertEqual((await expectGatewayError(call, 'ref_not_found')).details.ref, 'staging', 'names the source');
  }),
];
