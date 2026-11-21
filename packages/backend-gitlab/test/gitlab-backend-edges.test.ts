// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { encodePktLine } from '@leed-ai/git-gateway-core/pkt-line/encode';
import { describe, expect, it } from 'vite-plus/test';

import { GitLabBackend } from '../src/gitlab-backend.ts';
import { fakeGitLab } from './helpers/fake-gitlab.ts';

const SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const TOKEN = 'glpat-supersecret';
const NOT_AN_ACCESS_LEVEL: GitAccess = JSON.parse('"admin"');

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const project = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 9,
  path: 'r',
  path_with_namespace: 'acme/r',
  default_branch: 'main',
  created_at: '2026-11-20T09:30:00Z',
  http_url_to_repo: 'https://g.example/acme/r.git',
  marked_for_deletion_on: null,
  ...overrides,
});

/** A GitLabBackend whose API answers come from `answer`; every request is recorded. */
function scripted(answer: (method: string, path: string) => Response): {
  backend: GitLabBackend;
  seen: string[];
} {
  const seen: string[] = [];
  const backend = new GitLabBackend({
    baseUrl: 'https://g.example',
    token: TOKEN,
    namespace: 'acme',
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = `${url.pathname.replace(/^\/api\/v4/, '')}${url.search}`;
      seen.push(`${request.method} ${path}`);
      return answer(request.method, path);
    },
  });
  return { backend, seen };
}

async function errorOf(call: Promise<unknown>): Promise<ReturnType<typeof readGatewayError>> {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  return null;
}

describe('GitLabBackend input validation', () => {
  it('refuses every invalid argument as invalid_input without a request', async () => {
    const gitlab = fakeGitLab();
    const backend = new GitLabBackend({
      baseUrl: gitlab.state.base,
      token: gitlab.state.token,
      namespace: gitlab.state.group.fullPath,
      fetch: gitlab.fetch,
    });
    const invalid: (() => Promise<unknown>)[] = [
      () => backend.createRepo('Bad Name!'),
      () => backend.createRepo('r', { defaultBranch: 'refs/heads/main' }),
      () => backend.deleteRepo('r.git'),
      () => backend.repoInfo(''),
      () => backend.resolveRef('r', 'refs/remotes/origin/main'),
      () => backend.readCommit('r', 'abc'),
      () => backend.readTree('r', SHA.toUpperCase()),
      () => backend.readBlob('r', ''),
      () => backend.readFile('r', 'main', '/etc/passwd'),
      () => backend.readFile('r', 'a..b', 'a.md'),
      () => backend.log('r', 'main', { limit: 1001 }),
      () => backend.gitRemote('r', NOT_AN_ACCESS_LEVEL),
    ];
    for (const call of invalid) expect((await errorOf(call()))?.code).toBe('invalid_input');
    expect(gitlab.state.requests).toEqual([]);
  });
});

describe('GitLabBackend request shapes', () => {
  it('routes branches, full refs and tags to the right API, names URL-encoded', async () => {
    const { backend, seen } = scripted(() => json(200, { name: 'x', commit: { id: SHA } }));
    expect(await backend.resolveRef('r', 'feature/new-page')).toBe(SHA);
    await backend.resolveRef('r', 'refs/heads/main');
    await backend.resolveRef('r', 'refs/tags/v1.0.0');
    expect(seen).toEqual([
      'GET /projects/acme%2Fr/repository/branches/feature%2Fnew-page',
      'GET /projects/acme%2Fr/repository/branches/main',
      'GET /projects/acme%2Fr/repository/tags/v1.0.0',
    ]);
  });

  it('reads a file by its URL-encoded path at the revision given', async () => {
    const { backend, seen } = scripted(() => new Response('body'));
    expect(await backend.readFile('r', SHA, 'content/pages/a b+c.md')).toEqual(
      new TextEncoder().encode('body'),
    );
    expect(seen).toEqual([
      `GET /projects/acme%2Fr/repository/files/content%2Fpages%2Fa%20b%2Bc.md/raw?ref=${SHA}`,
    ]);
  });

  it('lists nothing for a revision GitLab does not know', async () => {
    const { backend } = scripted((_method, path) =>
      path === '/projects/acme%2Fr' ? json(200, project()) : json(404, { message: '404 Commit Not Found' }),
    );
    expect(await backend.log('r', 'no-such-branch', { limit: 5 })).toEqual([]);
  });
});

describe('GitLabBackend host failures', () => {
  it('reports server errors as retryable storage_unavailable without the token', async () => {
    const { backend } = scripted(() => new Response('upstream connect error', { status: 503 }));
    for (const call of [
      backend.repoInfo('r'),
      backend.resolveRef('r', 'main'),
      backend.readBlob('r', SHA),
      backend.log('r', 'main', { limit: 1 }),
      backend.gitRemote('r', 'read'),
      backend.deleteRepo('r'),
    ]) {
      const error = await errorOf(call);
      expect(error).toMatchObject({ code: 'storage_unavailable', details: { retryable: true } });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(btoa(`oauth2:${TOKEN}`));
    }
  });

  it('reports a git HTTP failure on readTree and log as storage_unavailable, not a missing object', async () => {
    for (const status of [401, 500, 503]) {
      const { backend, seen } = scripted((_method, path) => {
        if (path === '/projects/acme%2Fr') return json(200, project());
        if (path.startsWith('/projects/acme%2Fr/repository/commits?'))
          return json(200, [{ id: SHA, parent_ids: [] }]);
        return new Response('git host failure', { status });
      });
      for (const call of [backend.readTree('r', SHA), backend.log('r', 'main', { limit: 1 })]) {
        const error = await errorOf(call);
        expect(error).toMatchObject({ code: 'storage_unavailable' });
        expect(JSON.stringify(error)).not.toContain(TOKEN);
      }
      expect(seen.filter((line) => line === 'POST /acme/r.git/git-upload-pack')).toHaveLength(2);
    }
  });

  it('reads an in-protocol refusal (ERR in an HTTP 200) on readTree as a missing tree, not a failure', async () => {
    const { backend, seen } = scripted((_method, path) => {
      if (path === '/projects/acme%2Fr') return json(200, project());
      if (path === '/acme/r.git/git-upload-pack')
        return new Response(encodePktLine(`ERR upload-pack: not our ref ${SHA}\n`));
      return new Response('unexpected', { status: 500 });
    });
    expect(await backend.readTree('r', SHA)).toBeNull();
    expect(seen).toContain('POST /acme/r.git/git-upload-pack');
  });

  it('reports a git HTTP failure on readCommit as storage_unavailable, not a missing commit', async () => {
    for (const status of [401, 500, 503]) {
      const { backend } = scripted((_method, path) => {
        if (path === '/projects/acme%2Fr') return json(200, project());
        if (path === `/projects/acme%2Fr/repository/commits/${SHA}`) return json(200, { id: SHA });
        return new Response('git host failure', { status });
      });
      const error = await errorOf(backend.readCommit('r', SHA));
      expect(error).toMatchObject({ code: 'storage_unavailable', details: { retryable: true } });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(btoa(`oauth2:${TOKEN}`));
    }
  });

  it('reports a commit the API lists but git refuses as storage_unavailable, not null', async () => {
    const { backend } = scripted((_method, path) => {
      if (path === '/projects/acme%2Fr') return json(200, project());
      if (path === `/projects/acme%2Fr/repository/commits/${SHA}`) return json(200, { id: SHA });
      if (path === '/acme/r.git/git-upload-pack')
        return new Response(encodePktLine(`ERR upload-pack: not our ref ${SHA}\n`));
      return new Response('unexpected', { status: 500 });
    });
    expect(await errorOf(backend.readCommit('r', SHA))).toMatchObject({ code: 'storage_unavailable' });
  });

  it('reports a response the schemas reject as storage_unavailable', async () => {
    const malformed = scripted(() => json(200, { id: 'nine', path: 'r' }));
    expect((await errorOf(malformed.backend.repoInfo('r')))?.code).toBe('storage_unavailable');
    const badRef = scripted(() => json(200, { name: 'main', commit: { id: 'short' } }));
    expect((await errorOf(badRef.backend.resolveRef('r', 'main')))?.code).toBe('storage_unavailable');
    const notJson = scripted(() => new Response('<html>ok</html>'));
    expect((await errorOf(notJson.backend.repoInfo('r')))?.code).toBe('storage_unavailable');
  });

  it('reports create failures other than a taken name as storage_unavailable', async () => {
    const forbidden = scripted((method) =>
      method === 'GET' ? json(200, { id: 42, full_path: 'acme' }) : json(403, { message: '403 Forbidden' }),
    );
    expect((await errorOf(forbidden.backend.createRepo('r')))?.code).toBe('storage_unavailable');
    const invalid = scripted((method) =>
      method === 'GET'
        ? json(200, { id: 42, full_path: 'acme' })
        : json(400, { message: { path: ['can contain only letters'] } }),
    );
    expect((await errorOf(invalid.backend.createRepo('r')))?.code).toBe('storage_unavailable');
    const missingGroup = scripted(() => json(404, { message: '404 Group Not Found' }));
    expect((await errorOf(missingGroup.backend.createRepo('r')))?.code).toBe('storage_unavailable');
  });
});

describe('GitLabBackend projects pending deletion', () => {
  it('treats a project marked for deletion as missing', async () => {
    const { backend } = scripted(() => json(200, project({ marked_for_deletion_on: '2026-11-27' })));
    expect(await backend.repoInfo('r')).toBeNull();
    expect((await errorOf(backend.gitRemote('r', 'read')))?.code).toBe('repo_not_found');
  });

  it('deletes once when the instance removes projects straight away', async () => {
    let deleted = false;
    const { backend, seen } = scripted((method) => {
      if (method === 'DELETE') return ((deleted = true), json(202, { message: '202 Accepted' }));
      return deleted ? json(404, { message: '404 Project Not Found' }) : json(200, project());
    });
    await backend.deleteRepo('r');
    expect(seen).toEqual(['GET /projects/acme%2Fr', 'DELETE /projects/9', 'GET /projects/9']);
  });

  it('sends no delete for a missing project', async () => {
    const { backend, seen } = scripted(() => json(404, { message: '404 Project Not Found' }));
    await backend.deleteRepo('r');
    expect(seen).toEqual(['GET /projects/acme%2Fr']);
  });

  it('reports the default branch the project names, falling back to main when GitLab gives none', async () => {
    const named = scripted(() => json(200, project({ default_branch: 'trunk' })));
    expect((await named.backend.repoInfo('r'))?.defaultBranch).toBe('trunk');
    const none = scripted(() => json(200, project({ default_branch: null })));
    expect((await none.backend.repoInfo('r'))?.defaultBranch).toBe('main');
  });
});
