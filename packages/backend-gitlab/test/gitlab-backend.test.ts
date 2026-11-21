// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import { GitLabBackend } from '../src/gitlab-backend.ts';
import { fakeGitLab, type FakeGitLab } from './helpers/fake-gitlab.ts';

const backendFor = (
  gitlab: FakeGitLab,
  extra: { namespaceId?: number; token?: string } = {},
): GitLabBackend =>
  new GitLabBackend({
    baseUrl: gitlab.state.base,
    token: extra.token ?? gitlab.state.token,
    namespace: gitlab.state.group.fullPath,
    fetch: gitlab.fetch,
    ...(extra.namespaceId === undefined ? {} : { namespaceId: extra.namespaceId }),
  });

async function errorCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error)?.code;
  }
  return undefined;
}

describe('GitLabBackend', () => {
  it('looks the group id up once and creates private, empty projects with the default branch', async () => {
    const gitlab = fakeGitLab();
    const backend = backendFor(gitlab);
    await backend.createRepo('one');
    await backend.createRepo('two', { defaultBranch: 'trunk' });
    expect(gitlab.state.requests.filter((request) => request.startsWith('GET /groups/'))).toHaveLength(1);
    expect((await backend.repoInfo('two'))?.defaultBranch).toBe('trunk');
  });

  it('uses a configured group id without a lookup', async () => {
    const gitlab = fakeGitLab();
    await backendFor(gitlab, { namespaceId: 42 }).createRepo('one');
    expect(gitlab.state.requests.some((request) => request.startsWith('GET /groups/'))).toBe(false);
  });

  it('reports a rejected token as storage_unavailable and a missing project as repo_not_found', async () => {
    const gitlab = fakeGitLab();
    expect(await errorCode(backendFor(gitlab, { token: 'wrong' }).repoInfo('x'))).toBe('storage_unavailable');
    for (const call of [
      backendFor(gitlab).resolveRef('missing', 'main'),
      backendFor(gitlab).readBlob('missing', 'f'.repeat(40)),
      backendFor(gitlab).readFile('missing', 'main', 'a'),
      backendFor(gitlab).readCommit('missing', 'f'.repeat(40)),
      backendFor(gitlab).log('missing', 'main', { limit: 1 }),
      backendFor(gitlab).readTree('missing', 'f'.repeat(40)),
    ]) {
      expect(await errorCode(call)).toBe('repo_not_found');
    }
  });

  it('pages through more than one page of first-parent history', async () => {
    const gitlab = fakeGitLab();
    const backend = backendFor(gitlab);
    await backend.createRepo('long');
    const client = new GitHttpClient(await backend.gitRemote('long', 'write'), { fetch: gitlab.fetch });
    let parent: string | null = null;
    const objects = [];
    const shas: string[] = [];
    for (let index = 0; index < 130; index += 1) {
      const commit = await fixtureCommit(
        { 'n.txt': `${index}\n` },
        parent === null ? [] : [parent],
        `Commit ${index}\n`,
      );
      objects.push(...commit.objects);
      shas.unshift(commit.sha);
      parent = commit.sha;
    }
    await client.push([{ oldSha: ZERO_SHA, newSha: parent ?? '', ref: 'refs/heads/main' }], objects);
    const page = await backend.log('long', 'main', { limit: 20, offset: 105 });
    expect(page.map((commit) => commit.sha)).toEqual(shas.slice(105, 125));
    expect(gitlab.state.requests.filter((request) => request.includes('/repository/commits?'))).toHaveLength(
      2,
    );
  });

  it('gives read and write remotes the same Basic credential and no expiry', async () => {
    const gitlab = fakeGitLab();
    const backend = backendFor(gitlab);
    await backend.createRepo('r');
    const read = await backend.gitRemote('r', 'read');
    expect(read).toEqual(await backend.gitRemote('r', 'write'));
    expect(read).toEqual({
      url: `${gitlab.state.base}/acme/sites/r.git`,
      headers: { Authorization: `Basic ${btoa(`oauth2:${gitlab.state.token}`)}` },
      expiresAt: null,
    });
  });

  it('rejects an invalid configuration', () => {
    expect(() => new GitLabBackend({ token: '', namespace: 'acme' })).toThrow(ZodError);
    expect(() => new GitLabBackend({ token: 't', namespace: '/bad/' })).toThrow(ZodError);
    expect(() => new GitLabBackend({ token: 't', namespace: 'acme', baseUrl: 'ftp://x' })).toThrow(ZodError);
  });
});

describe('GitLabBackend.deleteRepo with delayed deletion', () => {
  it('marks the project, then removes it for good by its new path', async () => {
    const seen: string[] = [];
    let marked = false;
    const project = (path: string): unknown => ({
      id: 9,
      path,
      path_with_namespace: `acme/${path}`,
      default_branch: 'main',
      created_at: '2026-11-20T09:30:00Z',
      http_url_to_repo: `https://g.example/acme/${path}.git`,
      marked_for_deletion_on: marked ? '2026-11-27' : null,
    });
    const backend = new GitLabBackend({
      baseUrl: 'https://g.example',
      token: 't',
      namespace: 'acme',
      fetch: async (request) => {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname.slice(7)}${url.search}`);
        if (request.method === 'DELETE' && url.search === '') {
          marked = true;
          return new Response('{"message":"202 Accepted"}', { status: 202 });
        }
        if (request.method === 'DELETE') return new Response(null, { status: 202 });
        return new Response(JSON.stringify(project(marked ? 'r-deleted-9' : 'r')));
      },
    });
    await backend.deleteRepo('r');
    expect(seen).toEqual([
      'GET /projects/acme%2Fr',
      'DELETE /projects/9',
      'GET /projects/9',
      'DELETE /projects/9?permanently_remove=true&full_path=acme%2Fr-deleted-9',
    ]);
    expect(await backend.repoInfo('r')).toBeNull();
  });
});
