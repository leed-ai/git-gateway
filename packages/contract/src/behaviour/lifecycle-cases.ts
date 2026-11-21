// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, expectGatewayError } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { AUTHOR, freshKey, headOf, seedRepo } from './fixtures.ts';

const GROUP = 'repositories';
const SHA = 'ffffffffffffffffffffffffffffffffffffffff';

/** createRepo, deleteRepo, mintReadToken, missing repositories and input validation. */
export const lifecycleCases: readonly BehaviourCase[] = [
  behaviourCase(GROUP, 'createRepo creates an empty repository', async ({ gateway, repo }) => {
    const info = await gateway.createRepo({ repo });
    assertEqual([info.name, info.defaultBranch], [repo, 'main'], 'name and default branch');
    assertTrue(info.remoteUrl.endsWith(`/${repo}.git`), 'remote URL ends in /<repo>.git');
    assertEqual(await headOf(gateway, repo, 'main'), null, 'no branches until the first commit');
  }),
  behaviourCase(GROUP, 'createRepo honours defaultBranch', async ({ gateway, repo }) => {
    assertEqual(
      (await gateway.createRepo({ repo, defaultBranch: 'trunk' })).defaultBranch,
      'trunk',
      'default',
    );
  }),
  behaviourCase(GROUP, 'createRepo of an existing name is repo_exists', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const error = await expectGatewayError(gateway.createRepo({ repo }), 'repo_exists');
    assertEqual(error.details.repo, repo, 'names the repository');
    assertTrue((await headOf(gateway, repo, 'main')) !== null, 'existing repository untouched');
  }),
  behaviourCase(GROUP, 'deleteRepo deletes, and deleting again reports false', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    assertEqual(await gateway.deleteRepo({ repo }), { deleted: true }, 'deleted');
    assertEqual(await gateway.deleteRepo({ repo }), { deleted: false }, 'already gone');
    await expectGatewayError(gateway.resolveRef({ repo, ref: 'main' }), 'repo_not_found');
  }),
  behaviourCase(GROUP, 'every call on a missing repository is repo_not_found', async ({ gateway, repo }) => {
    const calls: (() => Promise<unknown>)[] = [
      () =>
        gateway.commit({
          repo,
          branch: 'main',
          message: 'm',
          author: AUTHOR,
          idempotencyKey: freshKey(),
          actions: [{ action: 'create', path: 'a', content: 'a' }],
        }),
      () => gateway.readFile({ repo, ref: 'main', path: 'a' }),
      () => gateway.listTree({ repo, ref: 'main' }),
      () => gateway.resolveRef({ repo, ref: 'main' }),
      () => gateway.log({ repo, ref: 'main' }),
      () => gateway.commitExists({ repo, sha: SHA }),
      () => gateway.syncBranch({ repo, from: 'main', into: 'staging' }),
      () => gateway.promote({ repo, from: 'staging', into: 'main', sha: SHA }),
      () => gateway.mintReadToken({ repo }),
    ];
    for (const call of calls) {
      assertEqual(
        (await expectGatewayError(call(), 'repo_not_found')).details.repo,
        repo,
        'names the repository',
      );
    }
  }),
  behaviourCase(GROUP, 'mintReadToken returns a token, expiry and clone URL', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const short = await gateway.mintReadToken({ repo, ttlSeconds: 60 });
    const long = await gateway.mintReadToken({ repo, ttlSeconds: 86_400 });
    assertTrue(short.token.length >= 16, 'token is long enough to be a secret');
    assertTrue(short.remoteUrl.endsWith(`/${repo}.git`), 'clone URL');
    assertTrue(Date.parse(long.expiresAt) - Date.parse(short.expiresAt) > 80_000_000, 'ttl honoured');
  }),
  behaviourCase(GROUP, 'malformed input is invalid_input and changes nothing', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const bad: (() => Promise<unknown>)[] = [
      () => gateway.createRepo({ repo: 'bad/name' }),
      () => gateway.readFile({ repo, ref: 'main', path: '../escape' }),
      () => gateway.readFile({ repo, ref: 'main', path: '.git/config' }),
      () => gateway.resolveRef({ repo, ref: 'a..b' }),
      () => gateway.commitExists({ repo, sha: 'ABC' }),
      () => gateway.log({ repo, ref: 'main', limit: 0 }),
      () => gateway.mintReadToken({ repo, ttlSeconds: 5 }),
      () =>
        gateway.commit({
          repo,
          branch: 'main',
          message: 'm',
          author: AUTHOR,
          idempotencyKey: freshKey(),
          actions: [],
        }),
      () =>
        gateway.commit({
          repo,
          branch: 'main',
          message: 'm',
          author: AUTHOR,
          idempotencyKey: freshKey(),
          actions: [{ action: 'move', path: 'README.md', previousPath: 'README.md' }],
        }),
    ];
    for (const call of bad) await expectGatewayError(call(), 'invalid_input');
    assertEqual(await headOf(gateway, repo, 'main'), seed.sha, 'nothing written');
  }),
];
