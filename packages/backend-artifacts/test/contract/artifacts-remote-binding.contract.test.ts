// SPDX-License-Identifier: Apache-2.0
import { registerBackendContractSuite } from '@leed-ai/git-gateway-testkit/contract-suite/backend-contract-suite';
import { env } from 'cloudflare:workers';
import { describe, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../../src/artifacts-backend.ts';
import type { ArtifactsNamespaceBinding, ArtifactsRepoHandle } from '../../src/artifacts-binding.ts';
import { releaseHandle } from '../../src/artifacts-binding.ts';
import { testBinding } from '../helpers/test-binding.ts';

/** What wrangler's remote binding throws when a call's result is a Blob. */
function unserializableBlob(): Error {
  return new Error('Cannot serialize value: [object Blob]');
}

/** Null passes; a Blob cannot be carried back. */
async function blobOrThrow(blob: Promise<Blob | null>): Promise<Blob | null> {
  if ((await blob) !== null) throw unserializableBlob();
  return null;
}

/**
 * A repository handle behaving as wrangler's remote Artifacts binding does under `wrangler dev`:
 * a call whose result is a Blob (readBlob, readFile) fails with "Cannot serialize value: [object
 * Blob]"; a null result, and every other call, comes back as usual.
 */
function remoteShapedHandle(handle: ArtifactsRepoHandle): ArtifactsRepoHandle {
  const wrapped: ArtifactsRepoHandle = {
    info: async () => handle.info(),
    createToken: async (scope, ttl) => handle.createToken(scope, ttl),
    revokeToken: async (token) => handle.revokeToken(token),
    readBlob: async (hash) => blobOrThrow(handle.readBlob(hash)),
    readTree: async (hash) => handle.readTree(hash),
    readCommit: async (hash) => handle.readCommit(hash),
    readFile: async (args) => blobOrThrow(handle.readFile(args)),
    log: async (opts) => handle.log(opts),
  };
  return Object.assign(wrapped, { [Symbol.dispose]: () => releaseHandle(handle) });
}

/** The local binding with every handle shaped as wrangler's remote binding hands them out. */
function remoteShapedBinding(binding: ArtifactsNamespaceBinding): ArtifactsNamespaceBinding {
  return {
    create: async (name, opts) => binding.create(name, opts),
    get: async (name) => remoteShapedHandle(await binding.get(name)),
    delete: async (name) => binding.delete(name),
  };
}

// The read and content groups again, through a binding that cannot carry Blobs back, so readBlob
// and readFile are served by the fallback over the repository's git remote.
registerBackendContractSuite(
  { describe, it },
  {
    name: 'StorageBackend contract (Artifacts local binding, as the wrangler remote binding)',
    createBackend: () => new ArtifactsBackend({ binding: remoteShapedBinding(testBinding(env)) }),
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
    repoPrefix: 'contract-rb',
    largeFileBytes: 5 * 1024 * 1024,
    include: (entry) => entry.group === 'reads' || entry.group === 'content',
  },
);
