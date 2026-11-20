// SPDX-License-Identifier: Apache-2.0
import type { ArtifactsNamespaceBinding, ArtifactsRepoHandle } from '../../src/artifacts-binding.ts';

/** An error shaped like the binding's ArtifactsError. */
export function artifactsError(code: string, message = code): Error {
  return Object.assign(new Error(message), { name: 'ArtifactsError', code, numericCode: 0 });
}

const notImplemented = async (): Promise<never> => {
  throw artifactsError('INTERNAL_ERROR', 'not scripted');
};

/** A repository handle whose methods default to INTERNAL_ERROR unless scripted. */
export function fakeHandle(
  overrides: Partial<ArtifactsRepoHandle> = {},
): ArtifactsRepoHandle & { disposed: number } {
  const handle = {
    disposed: 0,
    info: notImplemented,
    createToken: notImplemented,
    revokeToken: notImplemented,
    readBlob: notImplemented,
    readTree: notImplemented,
    readCommit: notImplemented,
    readFile: notImplemented,
    log: notImplemented,
    ...overrides,
    [Symbol.dispose]() {
      handle.disposed += 1;
    },
  };
  return handle;
}

/** A namespace binding returning `handle` from get() unless scripted otherwise. */
export function fakeBinding(
  handle: ArtifactsRepoHandle,
  overrides: Partial<ArtifactsNamespaceBinding> = {},
): ArtifactsNamespaceBinding {
  return { create: notImplemented, get: async () => handle, delete: async () => true, ...overrides };
}

/** A valid ArtifactsRepo.info() result. */
export const INFO = {
  id: 'r1',
  name: 'acme',
  description: null,
  defaultBranch: 'main',
  createdAt: '2026-11-20T09:30:00.000Z',
  updatedAt: '2026-11-20T09:30:00.000Z',
  lastPushAt: null,
  source: null,
  readOnly: false,
  remote: 'https://acct.artifacts.cloudflare.net/git/default/acme.git',
};
