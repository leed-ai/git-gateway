// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { describe, expect, it } from 'vite-plus/test';

import type { ArtifactsRepoHandle } from '../src/artifacts-binding.ts';
import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { isWrongKind } from '../src/artifacts-errors.ts';
import { artifactsError, fakeBinding, fakeHandle } from './helpers/fake-binding.ts';

const SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const OTHER = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** An error named like the binding's, with only a message: its code did not survive. */
const stripped = (message: string): Error => Object.assign(new Error(message), { name: 'ArtifactsError' });
/** What the live binding was seen to throw for readTree of a blob. */
const liveBlobAsTree = (sha: string): Error =>
  stripped(
    `ArtifactsError: Invalid object requested. SHA must identify a commit or a tree. ${sha} is a blob.`,
  );
const rejecting = (error: Error) => async (): Promise<never> => Promise.reject(error);

async function errorCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error)?.code;
  }
  return undefined;
}

const backendOver = (overrides: Partial<ArtifactsRepoHandle>): ArtifactsBackend =>
  new ArtifactsBackend({ binding: fakeBinding(fakeHandle(overrides)) });

describe('isWrongKind', () => {
  it.each([
    ['the live message', liveBlobAsTree(SHA)],
    [
      'the live message without its prefix',
      stripped(`Invalid object requested. SHA must identify a commit. ${SHA} is a tree.`),
    ],
    ["the simulator's message", artifactsError('INTERNAL_ERROR', `Git object ${SHA} is a blob, not a tree`)],
    [
      '"Invalid object requested" alone with "must identify"',
      stripped('Invalid object requested. SHA must identify a tree.'),
    ],
  ])('accepts %s', (_label, error) => {
    expect(isWrongKind(error, SHA)).toBe(true);
  });

  it.each([
    ['another id named', stripped(`Git object ${OTHER} is a blob, not a tree`)],
    ['an internal error', artifactsError('INTERNAL_ERROR', 'internal error')],
    ['an outage', stripped('Network connection lost.')],
    ['"Invalid object requested" alone', stripped('Invalid object requested')],
    ['a string', 'is a blob'],
    ['null', null],
  ])('refuses %s', (_label, error) => {
    expect(isWrongKind(error, SHA)).toBe(false);
  });
});

describe('ArtifactsBackend reads of an id of another kind', () => {
  it('reads a blob as a tree as null, as the live binding refuses it (no probe needed)', async () => {
    const probes: string[] = [];
    const backend = backendOver({
      readTree: rejecting(liveBlobAsTree(SHA)),
      readBlob: async () => (probes.push('readBlob'), new Blob(['x'])),
      readCommit: async () => (probes.push('readCommit'), null),
    });
    expect(await backend.readTree('acme', SHA)).toBeNull();
    expect(probes).toEqual([]);
  });

  it('reads a tree or a blob as a commit as null, whatever code survives', async () => {
    for (const error of [
      stripped(`Invalid object requested. SHA must identify a commit. ${SHA} is a tree.`),
      artifactsError(
        'INVALID_INPUT',
        `Invalid object requested. SHA must identify a commit. ${SHA} is a blob.`,
      ),
      artifactsError('INTERNAL_ERROR', `Git object ${SHA} is a tree, not a commit`),
    ]) {
      expect(await backendOver({ readCommit: rejecting(error) }).readCommit('acme', SHA)).toBeNull();
    }
  });

  it('reads a commit or a tree as a blob as null, when the binding refuses rather than answering null', async () => {
    const error = stripped(`Invalid object requested. SHA must identify a blob. ${SHA} is a commit.`);
    expect(await backendOver({ readBlob: rejecting(error) }).readBlob('acme', SHA)).toBeNull();
    expect(await backendOver({ readBlob: async () => null }).readBlob('acme', SHA)).toBeNull();
  });

  it('reads a file at a revision naming a tree as null', async () => {
    const error = stripped(`Invalid object requested. SHA must identify a commit. ${SHA} is a tree.`);
    expect(await backendOver({ readFile: rejecting(error) }).readFile('acme', SHA, 'a.md')).toBeNull();
  });

  it('reads a file at a revision naming a tree as null on the remote binding fallback', async () => {
    const backend = backendOver({
      readFile: rejecting(new Error('Cannot serialize value: [object Blob]')),
      readCommit: rejecting(stripped(`Git object ${SHA} is a tree, not a commit`)),
    });
    expect(await backend.readFile('acme', SHA, 'a.md')).toBeNull();
  });

  it('finds a code-less refusal to be a wrong kind by probing, when the message does not say', async () => {
    const backend = backendOver({
      readTree: rejecting(stripped('object is not a valid tree')),
      readBlob: async () => new Blob(['x']),
    });
    expect(await backend.readTree('acme', SHA)).toBeNull();
  });

  it('never swallows a real failure', async () => {
    // Code-less, unrecognised, and no probe finds the object: the original failure stands.
    const outage = backendOver({
      readTree: rejecting(stripped('Network connection lost.')),
      readBlob: rejecting(stripped('Network connection lost.')),
      readCommit: rejecting(stripped('Network connection lost.')),
    });
    expect(await errorCode(outage.readTree('acme', SHA))).toBe('storage_unavailable');
    // A documented code other than INTERNAL_ERROR is never probed.
    const probes: string[] = [];
    const limited = backendOver({
      readCommit: rejecting(artifactsError('MEMORY_LIMIT')),
      readBlob: async () => (probes.push('readBlob'), new Blob(['x'])),
    });
    expect(await errorCode(limited.readCommit('acme', SHA))).toBe('storage_unavailable');
    expect(probes).toEqual([]);
    // A message about another object is not about this one.
    const other = backendOver({ readBlob: rejecting(stripped(`Git object ${OTHER} is a tree, not a blob`)) });
    expect(await errorCode(other.readBlob('acme', SHA))).toBe('storage_unavailable');
    // A missing repository is still repo_not_found.
    const gone = backendOver({ readTree: rejecting(stripped('Repository not found: acme.')) });
    expect(await errorCode(gone.readTree('acme', SHA))).toBe('repo_not_found');
  });
});
