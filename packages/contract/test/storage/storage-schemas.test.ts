// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { GatewayError, readGatewayError } from '../../src/gateway-error.ts';
import { GitAccess, GitRemote } from '../../src/storage/git-remote.ts';
import { repoExists, repoNotFound, storageUnavailable } from '../../src/storage/storage-errors.ts';
import { parseStorageInput } from '../../src/storage/storage-input.ts';
import { StorageLogOptions, StorageRef } from '../../src/storage/storage-read.ts';
import { CreateStorageRepoOptions, StorageRepoInfo } from '../../src/storage/storage-repo-info.ts';
import { StorageTreeEntry } from '../../src/storage/storage-tree-entry.ts';

// The storage contract's schemas and helpers (spec → Storage backend contract), checked from both
// sides: what every backend must accept and what it must refuse before calling its host.

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const REMOTE = { url: 'https://h.example/r.git', headers: { Authorization: 'Bearer t' }, expiresAt: null };

describe('StorageRef', () => {
  it('accepts short branch names and refs under refs/heads/ or refs/tags/', () => {
    const refs = ['main', 'feature/x', 'refs/heads/main', 'refs/tags/v1.0.0', 'refs/heads/a/b'];
    expect(refs.filter((ref) => !ok(StorageRef, ref))).toEqual([]);
  });

  it('refuses other ref namespaces, HEAD, commit ids and invalid names', () => {
    const refs = [
      '',
      'HEAD',
      'refs/remotes/origin/main',
      'refs/notes/x',
      'refs/heads/',
      'refs/main',
      'a'.repeat(40),
      'bad..name',
      'with space',
      '-leading',
      'x.lock',
    ];
    expect(refs.filter((ref) => ok(StorageRef, ref))).toEqual([]);
  });
});

describe('StorageLogOptions', () => {
  it('defaults offset to 0 and keeps limit within 1–1000', () => {
    expect(StorageLogOptions.parse({ limit: 1 })).toEqual({ limit: 1, offset: 0 });
    expect(StorageLogOptions.parse({ limit: 1000, offset: 5 })).toEqual({ limit: 1000, offset: 5 });
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 10_000 }), (limit) => {
        expect(ok(StorageLogOptions, { limit })).toBe(limit >= 1 && limit <= 1000);
      }),
    );
  });

  it('refuses a negative or fractional offset, a fractional limit and unknown keys', () => {
    expect(ok(StorageLogOptions, { limit: 1, offset: -1 })).toBe(false);
    expect(ok(StorageLogOptions, { limit: 1, offset: 0.5 })).toBe(false);
    expect(ok(StorageLogOptions, { limit: 1.5 })).toBe(false);
    expect(ok(StorageLogOptions, {})).toBe(false);
    expect(ok(StorageLogOptions, { limit: 1, page: 2 })).toBe(false);
  });
});

describe('CreateStorageRepoOptions and StorageRepoInfo', () => {
  it('defaults the branch to main and refuses invalid branches and unknown keys', () => {
    expect(CreateStorageRepoOptions.parse({})).toEqual({ defaultBranch: 'main' });
    expect(ok(CreateStorageRepoOptions, { defaultBranch: 'refs/heads/main' })).toBe(false);
    expect(ok(CreateStorageRepoOptions, { defaultBranch: 'HEAD' })).toBe(false);
    expect(ok(CreateStorageRepoOptions, { defaultBranch: 'main', readOnly: true })).toBe(false);
  });

  it('carries no host URL or credential and allows an unknown creation time', () => {
    const info = { name: 'acme', defaultBranch: 'main', createdAt: null };
    expect(ok(StorageRepoInfo, info)).toBe(true);
    expect(ok(StorageRepoInfo, { ...info, remote: 'https://h.example/acme.git' })).toBe(false);
    expect(ok(StorageRepoInfo, { ...info, createdAt: 'yesterday' })).toBe(false);
    expect(ok(StorageRepoInfo, { ...info, name: 'acme.git' })).toBe(false);
  });
});

describe('StorageTreeEntry', () => {
  it('is a tree entry without a path', () => {
    const entry = { name: 'a.md', type: 'blob', mode: '100644', sha: 'e'.repeat(40) };
    expect(ok(StorageTreeEntry, entry)).toBe(true);
    expect(ok(StorageTreeEntry, { ...entry, path: 'a.md' })).toBe(false);
    expect(ok(StorageTreeEntry, { ...entry, sha: 'E'.repeat(40) })).toBe(false);
  });
});

describe('GitAccess and GitRemote', () => {
  it('knows only read and write', () => {
    expect(GitAccess.options).toEqual(['read', 'write']);
    expect(ok(GitAccess, 'admin')).toBe(false);
  });

  it('takes http(s) URLs, header records and an ISO expiry or null', () => {
    expect(ok(GitRemote, REMOTE)).toBe(true);
    expect(ok(GitRemote, { ...REMOTE, expiresAt: '2026-11-20T09:35:00.000Z' })).toBe(true);
    expect(ok(GitRemote, { ...REMOTE, url: 'ssh://h.example/r.git' })).toBe(false);
    expect(ok(GitRemote, { ...REMOTE, url: 'file:///r.git' })).toBe(false);
    expect(ok(GitRemote, { ...REMOTE, headers: { '': 'x' } })).toBe(false);
    expect(ok(GitRemote, { ...REMOTE, expiresAt: 1_764_000_000 })).toBe(false);
    expect(ok(GitRemote, { ...REMOTE, token: 't' })).toBe(false);
  });
});

describe('parseStorageInput', () => {
  it('returns the parsed value, defaults applied', () => {
    expect(parseStorageInput(StorageLogOptions, { limit: 3 })).toEqual({ limit: 3, offset: 0 });
  });

  it('throws an invalid_input GatewayError naming the field, never a ZodError', () => {
    let thrown: unknown;
    try {
      parseStorageInput(StorageLogOptions, { limit: 0 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect(thrown).not.toBeInstanceOf(z.ZodError);
    const body = readGatewayError(thrown);
    expect(body?.code).toBe('invalid_input');
    expect(body?.code === 'invalid_input' ? body.details.issues.map((issue) => issue.path) : []).toEqual([
      'limit',
    ]);
  });
});

describe('storage errors', () => {
  it('names the repository on repo_not_found and repo_exists', () => {
    expect(readGatewayError(repoNotFound('acme'))).toMatchObject({
      code: 'repo_not_found',
      details: { repo: 'acme' },
    });
    expect(readGatewayError(repoExists('acme'))).toMatchObject({
      code: 'repo_exists',
      details: { repo: 'acme' },
    });
  });

  it('marks storage_unavailable retryable and summarises errors and non-errors', () => {
    const fromError = readGatewayError(storageUnavailable('Artifacts log', new Error('timeout')));
    expect(fromError).toMatchObject({ code: 'storage_unavailable', details: { retryable: true } });
    expect(fromError?.message).toBe('Storage backend failed: Artifacts log: timeout');
    expect(readGatewayError(storageUnavailable('x', 'plain'))?.message).toBe(
      'Storage backend failed: x: plain',
    );
  });

  it('survives a transport that keeps only the message', () => {
    const crossed = new Error(repoNotFound('acme').message);
    expect(readGatewayError(crossed)?.code).toBe('repo_not_found');
  });
});
