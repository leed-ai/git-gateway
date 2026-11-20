// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import type { ArtifactsNamespaceBinding, ArtifactsRepoHandle } from '../src/artifacts-binding.ts';
import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { artifactsError, fakeBinding, fakeHandle, INFO } from './helpers/fake-binding.ts';

const SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const missing = async (): Promise<never> => Promise.reject(artifactsError('INTERNAL_ERROR'));
const NOT_AN_ACCESS_LEVEL: GitAccess = JSON.parse('"admin"');

async function errorOf(call: Promise<unknown>): Promise<ReturnType<typeof readGatewayError>> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  return null;
}

/** A binding that records every namespace and handle call it receives. */
function recordingBinding(): { binding: ArtifactsNamespaceBinding; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw artifactsError('INTERNAL_ERROR', `unexpected ${name}`);
  };
  const handle: ArtifactsRepoHandle = {
    info: record('info'),
    createToken: record('createToken'),
    revokeToken: record('revokeToken'),
    readBlob: record('readBlob'),
    readTree: record('readTree'),
    readCommit: record('readCommit'),
    readFile: record('readFile'),
    log: record('log'),
  };
  return {
    calls,
    binding: {
      create: record('create'),
      delete: record('delete'),
      get: async () => (calls.push('get'), handle),
    },
  };
}

describe('ArtifactsBackend input validation', () => {
  it('refuses every invalid argument as invalid_input without calling the binding', async () => {
    const { binding, calls } = recordingBinding();
    const backend = new ArtifactsBackend({ binding });
    const invalid: (() => Promise<unknown>)[] = [
      () => backend.createRepo('Bad Name!'),
      () => backend.createRepo('acme', { defaultBranch: 'a..b' }),
      () => backend.deleteRepo('acme.git'),
      () => backend.repoInfo(''),
      () => backend.resolveRef('acme', 'refs/remotes/origin/main'),
      () => backend.resolveRef('acme', 'HEAD'),
      () => backend.readCommit('acme', SHA.toUpperCase()),
      () => backend.readTree('acme', SHA.slice(2)),
      () => backend.readBlob('acme', `${SHA}0`),
      () => backend.readFile('acme', 'main', '../escape'),
      () => backend.readFile('acme', 'bad..ref', 'a.md'),
      () => backend.log('acme', 'main', { limit: 1, offset: -1 }),
      () => backend.log('acme', 'main', { limit: 2.5 }),
      () => backend.gitRemote('acme', NOT_AN_ACCESS_LEVEL),
    ];
    for (const call of invalid) expect((await errorOf(call()))?.code).toBe('invalid_input');
    expect(calls).toEqual([]);
  });

  it('accepts token lifetimes of 60 s to one year, 300 s by default', async () => {
    const minted: unknown[] = [];
    const handle = fakeHandle({
      info: async () => INFO,
      createToken: async (scope, ttl) => (
        minted.push(ttl),
        { id: 't', plaintext: 'p', scope, expiresAt: '2026-11-20T09:35:00.000Z' }
      ),
    });
    await new ArtifactsBackend({ binding: fakeBinding(handle) }).gitRemote('acme', 'write');
    await new ArtifactsBackend({ binding: fakeBinding(handle), tokenTtlSeconds: 60 }).gitRemote(
      'acme',
      'write',
    );
    await new ArtifactsBackend({ binding: fakeBinding(handle), tokenTtlSeconds: 31_536_000 }).gitRemote(
      'acme',
      'write',
    );
    expect(minted).toEqual([300, 60, 31_536_000]);
    for (const tokenTtlSeconds of [59, 31_536_001, 120.5]) {
      expect(() => new ArtifactsBackend({ binding: fakeBinding(handle), tokenTtlSeconds })).toThrow(ZodError);
    }
  });
});

describe('ArtifactsBackend handles and host failures', () => {
  it('releases the repository handle when the call fails', async () => {
    const handle = fakeHandle({ log: async () => Promise.reject(artifactsError('MEMORY_LIMIT')) });
    const backend = new ArtifactsBackend({ binding: fakeBinding(handle) });
    expect((await errorOf(backend.log('acme', 'main', { limit: 1 })))?.code).toBe('storage_unavailable');
    expect((await errorOf(backend.resolveRef('acme', 'main')))?.code).toBe('storage_unavailable');
    expect(handle.disposed).toBe(2);
  });

  it('works with handles that have no disposer', async () => {
    const plain: ArtifactsRepoHandle = {
      info: async () => INFO,
      createToken: missing,
      revokeToken: missing,
      readBlob: missing,
      readTree: missing,
      readCommit: missing,
      readFile: missing,
      log: missing,
    };
    const backend = new ArtifactsBackend({ binding: fakeBinding(plain) });
    expect((await backend.repoInfo('acme'))?.name).toBe('acme');
  });

  it('reports a creation whose info read fails as storage_unavailable, not repo_exists', async () => {
    const handle = fakeHandle({ revokeToken: async () => true });
    const backend = new ArtifactsBackend({
      binding: fakeBinding(handle, {
        create: async (name) => ({ id: 'r1', name, defaultBranch: 'main', remote: INFO.remote, token: 't' }),
      }),
    });
    expect((await errorOf(backend.createRepo('acme')))?.code).toBe('storage_unavailable');
    expect(handle.disposed).toBe(1);
  });

  it('reports an unparsable create result or token as storage_unavailable', async () => {
    const badCreate = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle(), { create: async () => ({ name: 'acme' }) }),
    });
    expect((await errorOf(badCreate.createRepo('acme')))?.code).toBe('storage_unavailable');
    const badToken = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle({ info: async () => INFO, createToken: async () => ({ id: 't' }) })),
    });
    expect((await errorOf(badToken.gitRemote('acme', 'read')))?.code).toBe('storage_unavailable');
  });

  it('never puts the minted token in an error message', async () => {
    const backend = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({
          info: async () => ({ ...INFO, remote: 'not a url' }),
          createToken: async (scope) => ({
            id: 't',
            plaintext: 'art_v2_supersecret',
            scope,
            expiresAt: '2026-11-20T09:35:00.000Z',
          }),
        }),
      ),
    });
    const error = await errorOf(backend.gitRemote('acme', 'write'));
    expect(error?.code).toBe('storage_unavailable');
    expect(JSON.stringify(error)).not.toContain('supersecret');
  });
});

describe('ArtifactsBackend reads', () => {
  it('resolves a ref to the head of its log', async () => {
    const backend = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({
          log: async () => [
            {
              hash: SHA,
              treeHash: TREE,
              message: 'm',
              parents: [],
              author: { name: 'A', email: 'a@example.com' },
              committer: { name: 'A', email: 'a@example.com' },
              authoredAt: 0,
              committedAt: 0,
            },
          ],
        }),
      ),
    });
    expect(await backend.resolveRef('acme', 'main')).toBe(SHA);
  });

  it('reads files by commit id unchanged, and maps missing blobs and files to null', async () => {
    const asked: unknown[] = [];
    const backend = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({
          readFile: async (args) => (asked.push(args), args.path === 'a.md' ? new Blob(['A']) : null),
          readBlob: async (hash) => (hash === SHA ? new Blob([new Uint8Array([0, 255])]) : null),
        }),
      ),
    });
    expect(await backend.readFile('acme', SHA, 'a.md')).toEqual(new TextEncoder().encode('A'));
    expect(await backend.readFile('acme', 'feature/x', 'missing.md')).toBeNull();
    expect(asked).toEqual([
      { ref: SHA, path: 'a.md' },
      { ref: 'refs/heads/feature/x', path: 'missing.md' },
    ]);
    expect(await backend.readBlob('acme', SHA)).toEqual(new Uint8Array([0, 255]));
    expect(await backend.readBlob('acme', TREE)).toBeNull();
  });

  it('reads a tree whose id is not an object at all as null', async () => {
    const backend = new ArtifactsBackend({
      binding: fakeBinding(fakeHandle({ readTree: async () => null, readCommit: async () => null })),
    });
    expect(await backend.readTree('acme', TREE)).toBeNull();
    expect(await backend.readCommit('acme', SHA)).toBeNull();
  });

  it('maps tree entries, normalising the tree mode and gitlinks', async () => {
    const backend = new ArtifactsBackend({
      binding: fakeBinding(
        fakeHandle({
          readTree: async () => [
            { name: 'dir', mode: '40000', hash: TREE, type: 'tree' },
            { name: 'sub', mode: '160000', hash: SHA, type: 'gitlink' },
            { name: 'run', mode: '100755', hash: SHA, type: 'exec' },
          ],
        }),
      ),
    });
    expect(await backend.readTree('acme', TREE)).toEqual([
      { name: 'dir', type: 'tree', mode: '040000', sha: TREE },
      { name: 'sub', type: 'commit', mode: '160000', sha: SHA },
      { name: 'run', type: 'blob', mode: '100755', sha: SHA },
    ]);
  });
});
