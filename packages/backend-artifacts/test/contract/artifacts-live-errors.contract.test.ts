// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { env } from 'cloudflare:workers';
import { describe, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../../src/artifacts-backend.ts';
import type { ArtifactsNamespaceBinding } from '../../src/artifacts-binding.ts';
import { testBinding } from '../helpers/test-binding.ts';

/** `error` with only its name and message, as an error that lost its own properties. */
function strip(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), { name: 'ArtifactsError' });
}

/**
 * The local binding with errors shaped as the live binding was seen to throw them: an
 * ArtifactsError whose `code` and `numericCode` did not survive, only its name and message.
 */
function liveShapedErrors(binding: ArtifactsNamespaceBinding): ArtifactsNamespaceBinding {
  return {
    create: async (name, opts) =>
      binding.create(name, opts).catch((error: unknown) => Promise.reject(strip(error))),
    get: async (name) => binding.get(name),
    delete: async (name) => binding.delete(name),
  };
}

// The lifecycle group again, with errors from create() shaped as live ones, so the
// "createRepo of an existing name is repo_exists" case covers what the live service sends (the
// simulator itself sends code ALREADY_EXISTS).
registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (Artifacts local binding, live-shaped errors)',
    createBackend: () => new ArtifactsBackend({ binding: liveShapedErrors(testBinding(env)) }),
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
    repoPrefix: 'contract-le',
    include: (entry) => entry.group === 'lifecycle',
  },
);
