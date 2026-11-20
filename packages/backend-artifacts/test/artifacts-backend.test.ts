// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { artifactsError, fakeBinding, fakeHandle, INFO } from './helpers/fake-binding.ts';

const SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const internal = async (): Promise<never> => Promise.reject(artifactsError('INTERNAL_ERROR'));

async function errorCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error)?.code;
  }
  return undefined;
}

describe('ArtifactsBackend with a scripted binding', () => {
  it('creates a repository, revokes the initial token, and reports the fresh info', async () => {
    const revoked: string[] = [];
    const handle = fakeHandle({
      info: async () => INFO,
      revokeToken: async (token) => (revoked.push(token), true),
    });
    const created: unknown[] = [];
    const backend = new ArtifactsBackend({
      binding: fakeBinding(handle, {
        create: async (name, opts) => {
          created.push([name, opts]);
          return { id: 'r1', name, defaultBranch: 'main', remote: INFO.remote, token: 'art_initial' };
        },
      }),
    });
    expect(await backend.createRepo('acme')).toEqual({
      name: 'acme',
      defaultBranch: 'main',
      createdAt: INFO.createdAt,
    });
    expect(created).toEqual([['acme', { setDefaultBranch: 'main' }]]);
    expect(revoked).toEqual(['art_initial']);
    expect(handle.disposed).toBe(1);
  });

  it('still creates the repository when revoking the initial token fails', async () => {
    const handle = fakeHandle({
      info: async () => INFO,
      revokeToken: async () => Promise.reject(artifactsError('INTERNAL_ERROR')),
    });
    const backend = new ArtifactsBackend({
      binding: fakeBinding(handle, {
        create: async (name) => ({ id: 'r1', name, defaultBranch: 'main', remote: INFO.remote, token: 't' }),
      }),
    });
    expect((await backend.createRepo('acme')).name).toBe('acme');
  });

  it('maps ALREADY_EXISTS, NOT_FOUND and other binding errors to gateway errors', async () => {
    const exists = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), {
        create: async () => Promise.reject(artifactsError('ALREADY_EXISTS')),
      }),
    });
    expect(await errorCode(exists.createRepo('acme'))).toBe('repo_exists');
    const missing = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), { get: async () => Promise.reject(artifactsError('NOT_FOUND')) }),
    });
    expect(await errorCode(missing.readBlob('acme', SHA))).toBe('repo_not_found');
    expect(await missing.repoInfo('acme')).toBeNull();
    const busy = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), {
        get: async () => Promise.reject(artifactsError('IMPORT_IN_PROGRESS')),
      }),
    });
    expect(await errorCode(busy.repoInfo('acme'))).toBe('storage_unavailable');
    expect(await errorCode(busy.readBlob('acme', SHA))).toBe('storage_unavailable');
    const thrownString = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), { get: async () => Promise.reject('plain') }),
    });
    expect(await errorCode(thrownString.readBlob('acme', SHA))).toBe('storage_unavailable');
  });

  it('treats deleting a missing repository as done, and other delete failures as storage_unavailable', async () => {
    const gone = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), { delete: async () => Promise.reject(artifactsError('NOT_FOUND')) }),
    });
    await expect(gone.deleteRepo('acme')).resolves.toBeUndefined();
    const broken = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), {
        delete: async () => Promise.reject(artifactsError('INTERNAL_ERROR')),
      }),
    });
    expect(await errorCode(broken.deleteRepo('acme'))).toBe('storage_unavailable');
  });

  it('reports host results the schemas reject as storage_unavailable', async () => {
    const backend = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({ info: async () => ({ name: 'acme' }), log: async () => [{ hash: 'nope' }] }),
      ),
    });
    expect(await errorCode(backend.repoInfo('acme'))).toBe('storage_unavailable');
    expect(await errorCode(backend.log('acme', 'main', { limit: 1 }))).toBe('storage_unavailable');
  });

  it('resolves short names as refs/heads and passes full refs through', async () => {
    const asked: unknown[] = [];
    const backend = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle({ log: async (opts) => (asked.push(opts), []) })),
    });
    expect(await backend.resolveRef('acme', 'main')).toBeNull();
    await backend.resolveRef('acme', 'refs/tags/v1');
    await backend.readFile('acme', 'main', 'a.md').catch(() => null);
    await backend.log('acme', SHA, { limit: 5, offset: 2 });
    expect(asked).toEqual([
      { ref: 'refs/heads/main', limit: 1 },
      { ref: 'refs/tags/v1', limit: 1 },
      { ref: SHA, limit: 5, offset: 2 },
    ]);
  });

  it('mints a scoped token per remote with the configured lifetime', async () => {
    const minted: unknown[] = [];
    const handle = fakeHandle({
      info: async () => INFO,
      createToken: async (scope, ttl) => (
        minted.push([scope, ttl]),
        { id: 't1', plaintext: 'art_secret', scope, expiresAt: '2026-11-20T09:35:00.000Z' }
      ),
    });
    const backend = new ArtifactsBackend({ binding: fakeBinding(handle), tokenTtlSeconds: 120 });
    expect(await backend.gitRemote('acme', 'read')).toEqual({
      url: INFO.remote,
      headers: { Authorization: 'Bearer art_secret' },
      expiresAt: '2026-11-20T09:35:00.000Z',
    });
    expect(minted).toEqual([['read', 120]]);
    expect(() => new ArtifactsBackend({ binding: fakeBinding(handle), tokenTtlSeconds: 30 })).toThrow(
      ZodError,
    );
  });

  it('reads an id of the wrong kind as null but surfaces a real internal error', async () => {
    const blobHandle = fakeHandle({
      readCommit: internal,
      readTree: internal,
      readBlob: async () => new Blob(['x']),
    });
    const backend = new ArtifactsBackend({ binding: fakeBinding(blobHandle) });
    expect(await backend.readCommit('acme', SHA)).toBeNull();
    expect(await backend.readTree('acme', SHA)).toBeNull();
    const broken = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({ readCommit: internal, readTree: internal, readBlob: async () => null }),
      ),
    });
    expect(await errorCode(broken.readCommit('acme', SHA))).toBe('storage_unavailable');
    const notFound = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({ readCommit: async () => Promise.reject(artifactsError('MEMORY_LIMIT')) }),
      ),
    });
    expect(await errorCode(notFound.readCommit('acme', SHA))).toBe('storage_unavailable');
  });
});
