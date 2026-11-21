// SPDX-License-Identifier: Apache-2.0
import { registerBehaviourSuite } from '@leed-ai/git-gateway-contract/behaviour/behaviour-suite';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, it } from 'vite-plus/test';

import { memoryGateway } from '../helpers/memory-gateway.ts';

// The contract's behaviour suite — the same calls the in-memory reference (the oracle) passes —
// against the real gateway: git objects built without a clone, pushed through receive-pack.
registerBehaviourSuite(
  { describe, it },
  { name: 'gateway RPC over the memory backend', createGateway: () => memoryGateway().gateway },
);

// One long-lived gateway and backend shared by every case, as a deployment would run, with cleanup.
const shared = memoryGateway({}, new MemoryBackend()).gateway;
registerBehaviourSuite(
  { describe, it },
  { name: 'gateway RPC (shared)', createGateway: () => shared, cleanup: true, repoPrefix: 'shared' },
);
