// SPDX-License-Identifier: Apache-2.0
import { repoNotFound, storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { describe, expect, it } from 'vite-plus/test';

import type { BackendCase } from '../../src/contract-suite/backend-case.ts';
import {
  BACKEND_CASES,
  runBackendCase,
  type BackendSuiteOptions,
} from '../../src/contract-suite/backend-contract-suite.ts';
import { MemoryBackend } from '../../src/memory/memory-backend.ts';

// The backend contract suite is only a safety argument if it fails a backend that breaks a rule.
// Each fault below wraps a correct MemoryBackend and breaks one rule the way a real backend could
// (several mirror host quirks the backends work around: Artifacts strips a trailing newline from
// messages, GitLab's API decodes bytes as text). The case that pins the rule must pass on the
// correct backend and fail on the faulty one.

/** A MemoryBackend with some methods replaced; `inner` is the correct backend underneath. */
type Fault = (inner: MemoryBackend) => Partial<StorageBackend>;

function wrap(inner: MemoryBackend, overrides: Partial<StorageBackend>): StorageBackend {
  return {
    createRepo: overrides.createRepo ?? (async (name, options) => inner.createRepo(name, options)),
    deleteRepo: overrides.deleteRepo ?? (async (name) => inner.deleteRepo(name)),
    repoInfo: overrides.repoInfo ?? (async (name) => inner.repoInfo(name)),
    resolveRef: overrides.resolveRef ?? (async (name, ref) => inner.resolveRef(name, ref)),
    readCommit: overrides.readCommit ?? (async (name, sha) => inner.readCommit(name, sha)),
    readTree: overrides.readTree ?? (async (name, sha) => inner.readTree(name, sha)),
    readBlob: overrides.readBlob ?? (async (name, sha) => inner.readBlob(name, sha)),
    readFile: overrides.readFile ?? (async (name, ref, path) => inner.readFile(name, ref, path)),
    log: overrides.log ?? (async (name, ref, options) => inner.log(name, ref, options)),
    gitRemote: overrides.gitRemote ?? (async (name, access) => inner.gitRemote(name, access)),
  };
}

async function nullAsMissing<T>(call: Promise<T | null>, repo: string): Promise<T | null> {
  const value = await call;
  if (value === null) throw repoNotFound(repo);
  return value;
}

const LARGE = 2 * 1024 * 1024;

/** Case name → a fault that case must catch. */
const faults: Record<string, Fault> = {
  'repoInfo of a missing repository is null': (inner) => ({
    repoInfo: async (name) => nullAsMissing(inner.repoInfo(name), name),
  }),
  'deleteRepo deletes, and deleting a missing repository does nothing': (inner) => ({
    deleteRepo: async (name) => {
      await nullAsMissing(inner.repoInfo(name), name);
      await inner.deleteRepo(name);
    },
  }),
  'createRepo honours defaultBranch': (inner) => ({
    createRepo: async (name) => inner.createRepo(name),
  }),
  'every read and gitRemote on a missing repository is repo_not_found': (inner) => ({
    readFile: async (name, ref, path) => {
      if ((await inner.repoInfo(name)) === null) return null;
      return inner.readFile(name, ref, path);
    },
  }),
  'invalid arguments are invalid_input before the host is called': (inner) => ({
    log: async (name, ref, options) =>
      inner.log(name, ref, { ...options, limit: Math.min(Math.max(options.limit, 1), 1000) }),
  }),
  'readCommit returns a pushed commit exactly, trailer parsed': (inner) => ({
    readCommit: async (name, sha) => {
      const commit = await inner.readCommit(name, sha);
      return commit === null ? null : { ...commit, message: commit.message.replace(/\n$/, '') };
    },
  }),
  'readCommit of an unknown id is null': (inner) => ({
    readCommit: async (name, sha) => {
      const commit = await inner.readCommit(name, sha);
      if (commit === null) throw storageUnavailable('readCommit', new Error('object not found'));
      return commit;
    },
  }),
  'reading an id as the wrong kind of object is null': (inner) => ({
    readBlob: async (name, sha) => {
      const blob = await inner.readBlob(name, sha);
      if (blob !== null) return blob;
      const tree = await inner.readTree(name, sha);
      return tree === null ? null : new TextEncoder().encode(JSON.stringify(tree));
    },
  }),
  'readTree lists one level in stored order with kinds and modes': (inner) => ({
    readTree: async (name, sha) => (await inner.readTree(name, sha))?.toReversed() ?? null,
  }),
  'readTree of an unknown id is null': (inner) => ({
    readTree: async (name, sha) => (await inner.readTree(name, sha)) ?? [],
  }),
  'readFile is null for a missing path, a directory, a missing branch or commit': (inner) => ({
    readFile: async (name, ref, path) => (await inner.readFile(name, ref, path)) ?? new Uint8Array(),
  }),
  'log lists the first-parent chain newest first, with limit and offset': (inner) => ({
    log: async (name, ref, { limit }) => inner.log(name, ref, { limit }),
  }),
  'resolveRef resolves short names, full refs and tags; null when missing': (inner) => ({
    resolveRef: async (name, ref) => (ref.startsWith('refs/tags/') ? null : inner.resolveRef(name, ref)),
  }),
  'unicode paths and every byte value round-trip': (inner) => ({
    readFile: async (name, ref, path) => {
      const bytes = await inner.readFile(name, ref, path);
      return bytes === null ? null : new TextEncoder().encode(new TextDecoder().decode(bytes));
    },
  }),
  'a large binary file round-trips through readBlob, readFile and fetch': (inner) => ({
    readBlob: async (name, sha) => (await inner.readBlob(name, sha))?.slice(0, LARGE / 2) ?? null,
  }),
  'gitRemote mints a remote whose headers authorize it': (inner) => ({
    gitRemote: async (name, access) => {
      const remote = await inner.gitRemote(name, access);
      return { ...remote, url: remote.url.replace('://', '://user:secret@') };
    },
  }),
  'a read remote cannot push when the host scopes credentials': (inner) => ({
    gitRemote: async (name) => inner.gitRemote(name, 'write'),
  }),
  'an empty repository has no refs, no history and no files': (inner) => ({
    log: async (name, ref, options) => {
      const commits = await inner.log(name, ref, options);
      if (commits.length === 0) throw storageUnavailable('log', new Error('empty repository'));
      return commits;
    },
  }),
};

function caseNamed(name: string): BackendCase {
  const found = BACKEND_CASES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no backend contract case named "${name}"`);
  return found;
}

function optionsFor(inner: MemoryBackend, backend: StorageBackend): BackendSuiteOptions {
  return {
    createBackend: () => backend,
    fetch: inner.fetch,
    behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
    repoPrefix: 'fault',
    largeFileBytes: LARGE,
  };
}

describe('the backend contract suite detects faults', () => {
  it.each(Object.entries(faults))(
    '"%s" passes a correct backend and fails a faulty one',
    async (name, fault) => {
      const entry = caseNamed(name);
      const correct = new MemoryBackend();
      await expect(runBackendCase(entry, optionsFor(correct, wrap(correct, {})))).resolves.toBeUndefined();
      const inner = new MemoryBackend();
      await expect(
        runBackendCase(entry, optionsFor(inner, wrap(inner, fault(inner)))),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  it('declares a host that refuses non-fast-forwards, and fails a host that accepts them', async () => {
    const entry = caseNamed('a non-fast-forward naming the current head follows the host behaviour');
    const inner = new MemoryBackend();
    const accepting: BackendSuiteOptions = optionsFor(inner, wrap(inner, {}));
    await expect(runBackendCase(entry, accepting)).resolves.toBeUndefined();
    await expect(
      runBackendCase(entry, {
        ...accepting,
        behaviour: { ...accepting.behaviour, nonFastForward: 'refused' },
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
