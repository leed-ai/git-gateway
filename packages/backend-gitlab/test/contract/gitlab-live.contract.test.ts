// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { describe, it } from 'vite-plus/test';

import { GitLabBackend } from '../../src/gitlab-backend.ts';

// The GitLab leg of the backend contract suite against a real GitLab group, creating and deleting
// one disposable project per case. Runs only when GITLAB_CONTRACT_TOKEN is set (the contract
// workflow's main/nightly leg); GITLAB_CONTRACT_NAMESPACE names the group and GITLAB_CONTRACT_URL
// the instance (default https://gitlab.com). Branches other than the default are used for
// force-push and delete cases, since GitLab protects the default branch.
const token = process.env['GITLAB_CONTRACT_TOKEN'] ?? '';
const namespace = process.env['GITLAB_CONTRACT_NAMESPACE'] ?? '';
const baseUrl = process.env['GITLAB_CONTRACT_URL'] ?? 'https://gitlab.com';
const configured = token !== '' && namespace !== '';

describe.skipIf(!configured)('GitLab live leg', () => {
  registerBackendContractSuite(
    { describe, it },
    {
      name: 'StorageBackend contract (GitLab)',
      createBackend: () => new GitLabBackend({ baseUrl, token, namespace }),
      behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: false },
      repoPrefix: 'gg-contract',
      largeFileBytes: 2 * 1024 * 1024,
    },
  );
});
