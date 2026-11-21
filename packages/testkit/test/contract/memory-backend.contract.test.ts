// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'vite-plus/test';

import { registerBackendContractSuite } from '../../src/contract-suite/backend-contract-suite.ts';
import { MemoryBackend } from '../../src/memory/memory-backend.ts';

// The in-memory leg of the backend contract suite: one long-lived backend shared by every case,
// remotes reached through its in-process smart-HTTP handler.
const backend = new MemoryBackend();

registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (in-memory)',
    createBackend: () => backend,
    fetch: backend.fetch,
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
    repoPrefix: 'memory',
  },
);
