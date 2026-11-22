// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { env } from 'cloudflare:workers';
import { describe, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../../src/artifacts-backend.ts';
import type { ArtifactsNamespaceBinding, ArtifactsRepoHandle } from '../../src/artifacts-binding.ts';
import { releaseHandle } from '../../src/artifacts-binding.ts';
import { testBinding } from '../helpers/test-binding.ts';

/** `error` with only its name and message, as an error that lost its own properties. */
function strip(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), { name: 'ArtifactsError' });
}

/** Rejects with the stripped form of whatever `call` rejects with. */
async function stripped<T>(call: Promise<T>): Promise<T> {
  return call.catch((error: unknown) => Promise.reject(strip(error)));
}

/** A repository handle whose every call fails with live-shaped errors. */
function liveShapedHandle(handle: ArtifactsRepoHandle): ArtifactsRepoHandle {
  const wrapped: ArtifactsRepoHandle = {
    info: async () => stripped(handle.info()),
    createToken: async (scope, ttl) => stripped(handle.createToken(scope, ttl)),
    revokeToken: async (token) => stripped(handle.revokeToken(token)),
    readBlob: async (hash) => stripped(handle.readBlob(hash)),
    readTree: async (hash) => stripped(handle.readTree(hash)),
    readCommit: async (hash) => stripped(handle.readCommit(hash)),
    readFile: async (args) => stripped(handle.readFile(args)),
    log: async (opts) => stripped(handle.log(opts)),
  };
  return Object.assign(wrapped, { [Symbol.dispose]: () => releaseHandle(handle) });
}

/**
 * The local binding with errors shaped as the live binding was seen to throw them: an
 * ArtifactsError whose `code` and `numericCode` did not survive, only its name and message.
 */
function liveShapedErrors(binding: ArtifactsNamespaceBinding): ArtifactsNamespaceBinding {
  return {
    create: async (name, opts) =>
      binding.create(name, opts).catch((error: unknown) => Promise.reject(strip(error))),
    get: async (name) => liveShapedHandle(await stripped(binding.get(name))),
    delete: async (name) => stripped(binding.delete(name)),
  };
}

// The lifecycle group again, with every binding error shaped as live ones, so the
// "createRepo of an existing name is repo_exists" and "every read and gitRemote on a missing
// repository is repo_not_found" cases cover what the live service sends (the simulator itself
// sends codes ALREADY_EXISTS and NOT_FOUND).
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
