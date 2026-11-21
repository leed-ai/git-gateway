// SPDX-License-Identifier: Apache-2.0
import {
  assertEqual,
  assertTrue,
  expectGatewayError,
} from '@leed-ai/git-gateway-contract/behaviour/assertions';
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { StorageRepoInfo } from '@leed-ai/git-gateway-contract/storage/storage-repo-info';

import { backendCase, type BackendCase } from './backend-case.ts';
import { seedRepo } from './push-helpers.ts';

const GROUP = 'lifecycle';
const SHA = 'ffffffffffffffffffffffffffffffffffffffff';
/** An access level outside the schema, smuggled past the type checker as a caller without types would. */
const NOT_AN_ACCESS_LEVEL: GitAccess = JSON.parse('"admin"');

/** createRepo, repoInfo, deleteRepo, missing repositories and input validation. */
export const lifecycleCases: readonly BackendCase[] = [
  backendCase(
    GROUP,
    'createRepo creates an empty repository and repoInfo describes it',
    async ({ backend, repo }) => {
      const created = await backend.createRepo(repo);
      assertTrue(StorageRepoInfo.safeParse(created).success, 'createRepo returns a StorageRepoInfo');
      assertEqual([created.name, created.defaultBranch], [repo, 'main'], 'name and default branch "main"');
      assertEqual(await backend.repoInfo(repo), created, 'repoInfo reports what createRepo returned');
    },
  ),
  backendCase(GROUP, 'createRepo honours defaultBranch', async ({ backend, repo }) => {
    const created = await backend.createRepo(repo, { defaultBranch: 'trunk' });
    assertEqual(created.defaultBranch, 'trunk', 'createRepo result');
    assertEqual((await backend.repoInfo(repo))?.defaultBranch, 'trunk', 'repoInfo');
  }),
  backendCase(
    GROUP,
    'createRepo of an existing name is repo_exists and leaves it untouched',
    async (context) => {
      const seeded = await seedRepo(context);
      const error = await expectGatewayError(context.backend.createRepo(context.repo), 'repo_exists');
      assertEqual(error.details.repo, context.repo, 'names the repository');
      assertEqual(await context.backend.resolveRef(context.repo, 'main'), seeded.sha, 'history kept');
    },
  ),
  backendCase(
    GROUP,
    'deleteRepo deletes, and deleting a missing repository does nothing',
    async (context) => {
      await seedRepo(context);
      await context.backend.deleteRepo(context.repo);
      assertEqual(await context.backend.repoInfo(context.repo), null, 'repoInfo is null after delete');
      await context.backend.deleteRepo(context.repo);
      await expectGatewayError(context.backend.resolveRef(context.repo, 'main'), 'repo_not_found');
    },
  ),
  backendCase(GROUP, 'repoInfo of a missing repository is null', async ({ backend, repo }) => {
    assertEqual(await backend.repoInfo(repo), null, 'null');
  }),
  backendCase(
    GROUP,
    'every read and gitRemote on a missing repository is repo_not_found',
    async ({ backend, repo }) => {
      const calls: (() => Promise<unknown>)[] = [
        () => backend.resolveRef(repo, 'main'),
        () => backend.readCommit(repo, SHA),
        () => backend.readTree(repo, SHA),
        () => backend.readBlob(repo, SHA),
        () => backend.readFile(repo, 'main', 'README.md'),
        () => backend.log(repo, 'main', { limit: 10 }),
        () => backend.gitRemote(repo, 'read'),
        () => backend.gitRemote(repo, 'write'),
      ];
      for (const call of calls) {
        assertEqual(
          (await expectGatewayError(call(), 'repo_not_found')).details.repo,
          repo,
          'names the repository',
        );
      }
    },
  ),
  backendCase(
    GROUP,
    'invalid arguments are invalid_input before the host is called',
    async ({ backend, repo }) => {
      await backend.createRepo(repo);
      const calls: (() => Promise<unknown>)[] = [
        () => backend.createRepo('bad name!'),
        () => backend.createRepo(`${repo}-x`, { defaultBranch: 'bad..branch' }),
        () => backend.repoInfo('x.git'),
        () => backend.resolveRef(repo, 'refs/remotes/origin/main'),
        () => backend.readCommit(repo, 'ABC'),
        () => backend.readTree(repo, SHA.slice(1)),
        () => backend.readBlob(repo, ''),
        () => backend.readFile(repo, 'main', '/abs/path'),
        () => backend.log(repo, 'main', { limit: 0 }),
        () => backend.log(repo, 'main', { limit: 1001 }),
        () => backend.gitRemote(repo, NOT_AN_ACCESS_LEVEL),
      ];
      for (const call of calls) await expectGatewayError(call(), 'invalid_input');
      assertEqual(await backend.repoInfo(`${repo}-x`), null, 'nothing was created');
    },
  ),
  backendCase(
    GROUP,
    'invalid arguments on a missing repository are invalid_input, not repo_not_found',
    async ({ backend, repo }) => {
      const calls: (() => Promise<unknown>)[] = [
        () => backend.resolveRef(repo, 'refs/remotes/origin/main'),
        () => backend.readCommit(repo, 'ABC'),
        () => backend.readTree(repo, SHA.slice(1)),
        () => backend.readBlob(repo, ''),
        () => backend.readFile(repo, 'main', '/abs/path'),
        () => backend.readFile(repo, 'bad..branch', 'README.md'),
        () => backend.log(repo, 'main', { limit: 0 }),
        () => backend.gitRemote(repo, NOT_AN_ACCESS_LEVEL),
      ];
      for (const call of calls) await expectGatewayError(call(), 'invalid_input');
    },
  ),
];
