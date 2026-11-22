// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { describe, expect, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { fakeBinding, fakeHandle } from './helpers/fake-binding.ts';

const SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** An error named like the binding's, with `extra` own properties. */
const named = (message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { name: 'ArtifactsError', ...extra });

async function errorCode(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error)?.code ?? null;
  }
  return null;
}

/** A backend whose binding fails `get` and every handle call with `error`. */
function missing(error: Error): ArtifactsBackend {
  const fail = async (): Promise<never> => Promise.reject(error);
  return new ArtifactsBackend({
    binding: fakeBinding(
      fakeHandle({
        info: fail,
        readBlob: fail,
        readTree: fail,
        readCommit: fail,
        readFile: fail,
        log: fail,
        createToken: fail,
      }),
      { get: fail, delete: fail },
    ),
  });
}

/** Every call that goes through a repository handle. */
const handleCalls = (backend: ArtifactsBackend) => [
  backend.resolveRef('gwar08', 'main'),
  backend.readCommit('gwar08', SHA),
  backend.readTree('gwar08', SHA),
  backend.readBlob('gwar08', SHA),
  backend.readFile('gwar08', 'main', 'a.md'),
  backend.log('gwar08', 'main', { limit: 1 }),
  backend.gitRemote('gwar08', 'read'),
];

describe('a missing repository, as the live binding reports it', () => {
  it.each([
    ['the message alone (as seen live)', named('Repository not found: gwar08.')],
    ['the message without its period, after a prefix', named('ArtifactsError: Repository not found: gwar08')],
    ['the numeric code alone', named('gone', { code: 'INTERNAL_ERROR', numericCode: 10200 })],
    ['the documented code', named('gone', { code: 'NOT_FOUND' })],
  ])('is repo_not_found on every handle call, given %s', async (_label, error) => {
    const backend = missing(error);
    for (const call of handleCalls(backend)) expect(await errorCode(call)).toBe('repo_not_found');
    expect(await backend.repoInfo('gwar08')).toBeNull();
    await expect(backend.deleteRepo('gwar08')).resolves.toBeUndefined();
  });

  it('matches narrowly: another repository or other wording stays storage_unavailable', async () => {
    for (const error of [
      named('Repository not found: gwar08-old.'),
      named('Repository not found somewhere'),
    ]) {
      const backend = missing(error);
      for (const call of handleCalls(backend)) expect(await errorCode(call)).toBe('storage_unavailable');
      expect(await errorCode(backend.deleteRepo('gwar08'))).toBe('storage_unavailable');
    }
  });
});
