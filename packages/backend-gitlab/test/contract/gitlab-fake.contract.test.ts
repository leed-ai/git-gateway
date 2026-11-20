// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { describe, it } from 'vite-plus/test';

import { GitLabBackend } from '../../src/gitlab-backend.ts';
import { fakeGitLab } from '../helpers/fake-gitlab.ts';

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
