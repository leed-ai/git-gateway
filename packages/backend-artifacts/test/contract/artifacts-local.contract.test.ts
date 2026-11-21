// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { env } from 'cloudflare:workers';
import { describe, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../../src/artifacts-backend.ts';
import { testBinding } from '../helpers/test-binding.ts';

// The Artifacts leg of the backend contract suite, against the Artifacts local simulator: the
// real binding API, real git remotes on loopback (git http-backend underneath).
registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (Artifacts local binding)',
    createBackend: () => new ArtifactsBackend({ binding: testBinding(env) }),
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
    repoPrefix: 'contract',
    largeFileBytes: 5 * 1024 * 1024,
  },
);
