// SPDX-License-Identifier: Apache-2.0
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { describe, it } from 'vite-plus/test';

import { GitLabBackend } from '../../src/gitlab-backend.ts';
import { fakeGitLab, plantProject, removeProject } from '../helpers/fake-gitlab.ts';

// The backend contract suite against a fake GitLab (REST API and git smart HTTP over the
// in-memory backend), on every run. The real-GitLab leg (gitlab-live.contract.test.ts) runs only
// with credentials.
const gitlab = fakeGitLab();

registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (GitLab backend, fake GitLab)',
    createBackend: () =>
      new GitLabBackend({
        baseUrl: gitlab.state.base,
        token: gitlab.state.token,
        namespace: gitlab.state.group.fullPath,
        fetch: gitlab.fetch,
      }),
    fetch: gitlab.fetch,
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: false },
    repoPrefix: 'fake',
  },
);

// The same suite through fronted projects: every case's repository is an existing project planted
// outside the backend's group, under the fronted namespace, and the backend opens it only by its
// reserved name gl-<projectId>. The adapter below plants and removes those projects in place of
// createRepo and deleteRepo (which refuse reserved names) and maps each case's name to the reserved
// one, so every read, transport, push and content rule runs against the by-id path. The lifecycle
// group is left out: it tests createRepo and deleteRepo themselves, which fronted names refuse
// (covered in gitlab-backend-fronted.test.ts).
const fronted = fakeGitLab();
const FRONTED_NAMESPACE = 'acme/customers';

/** `info` renamed to the case's own repository name. */
const named = <T extends { name: string } | null>(repo: string, info: T): T =>
  info === null ? info : { ...info, name: repo };

function frontedBackend(): StorageBackend {
  const inner = new GitLabBackend({
    baseUrl: fronted.state.base,
    token: fronted.state.token,
    namespace: fronted.state.group.fullPath,
    frontedProjects: { namespace: FRONTED_NAMESPACE },
    fetch: fronted.fetch,
  });
  const ids = new Map<string, number>();
  const reserved = (repo: string): string => {
    const id = ids.get(repo);
    return id === undefined ? repo : `gl-${id}`;
  };
  return {
    createRepo: async (repo, options) => {
      const id = await plantProject(
        fronted.state,
        repo,
        `${FRONTED_NAMESPACE}/sites`,
        options?.defaultBranch,
      );
      ids.set(repo, id);
      const info = await inner.repoInfo(`gl-${id}`);
      if (info === null) throw new Error(`planted project ${repo} is not visible`);
      return named(repo, info);
    },
    deleteRepo: async (repo) => {
      if (ids.has(repo)) await removeProject(fronted.state, repo);
      ids.delete(repo);
    },
    repoInfo: async (repo) => named(repo, await inner.repoInfo(reserved(repo))),
    resolveRef: async (repo, ref) => inner.resolveRef(reserved(repo), ref),
    readCommit: async (repo, sha) => inner.readCommit(reserved(repo), sha),
    readTree: async (repo, sha) => inner.readTree(reserved(repo), sha),
    readBlob: async (repo, sha) => inner.readBlob(reserved(repo), sha),
    readFile: async (repo, ref, path) => inner.readFile(reserved(repo), ref, path),
    log: async (repo, ref, options) => inner.log(reserved(repo), ref, options),
    gitRemote: async (repo, access) => inner.gitRemote(reserved(repo), access),
  };
}

registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (GitLab backend, fronted projects by id, fake GitLab)',
    createBackend: frontedBackend,
    fetch: fronted.fetch,
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: false },
    repoPrefix: 'fronted',
    include: (entry) => entry.group !== 'lifecycle',
  },
);
