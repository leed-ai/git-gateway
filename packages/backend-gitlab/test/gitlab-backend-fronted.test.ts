// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { describe, expect, it } from 'vite-plus/test';

import { GitLabBackend } from '../src/gitlab-backend.ts';
import { fakeGitLab, plantProject, type FakeGitLab } from './helpers/fake-gitlab.ts';

const CUSTOMERS = 'acme/customers';

const backendFor = (gitlab: FakeGitLab, prefix?: string): GitLabBackend =>
  new GitLabBackend({
    baseUrl: gitlab.state.base,
    token: gitlab.state.token,
    namespace: gitlab.state.group.fullPath,
    frontedProjects: { namespace: CUSTOMERS, ...(prefix === undefined ? {} : { prefix }) },
    fetch: gitlab.fetch,
  });

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  return null;
}

describe('GitLabBackend fronted projects', () => {
  it('opens an existing project under the fronted namespace by id, named by its reserved name', async () => {
    const gitlab = fakeGitLab();
    const id = await plantProject(gitlab.state, 'raw-content', `${CUSTOMERS}/production/acme`);
    const backend = backendFor(gitlab);
    const info = await backend.repoInfo(`gl-${id}`);
    expect(info?.name).toBe(`gl-${id}`);
    expect(info?.defaultBranch).toBe('main');
    expect(gitlab.state.requests).toContain(`GET /projects/${id}`);
  });

  it('reads and pushes through the reserved name', async () => {
    const gitlab = fakeGitLab();
    const id = await plantProject(gitlab.state, 'raw-content', `${CUSTOMERS}/acme`);
    const backend = backendFor(gitlab);
    const seed = await fixtureCommit({ 'a.md': 'hello' });
    const client = new GitHttpClient(await backend.gitRemote(`gl-${id}`, 'write'), { fetch: gitlab.fetch });
    await client.push([{ oldSha: ZERO_SHA, newSha: seed.sha, ref: 'refs/heads/main' }], seed.objects);
    const seeded = seed.sha;
    expect(await backend.resolveRef(`gl-${id}`, 'main')).toBe(seeded);
    expect(new TextDecoder().decode((await backend.readFile(`gl-${id}`, 'main', 'a.md')) ?? undefined)).toBe(
      'hello',
    );
    expect((await backend.log(`gl-${id}`, 'main', { limit: 5 })).map((commit) => commit.sha)).toEqual([
      seeded,
    ]);
    const remote = await backend.gitRemote(`gl-${id}`, 'write');
    expect(remote.url).toBe(`${gitlab.state.base}/${CUSTOMERS}/acme/raw-content.git`);
  });

  it('answers repo_not_found for a project outside the fronted namespace, and null from repoInfo', async () => {
    const gitlab = fakeGitLab();
    const id = await plantProject(gitlab.state, 'cms', 'acme/services');
    const backend = backendFor(gitlab);
    expect(await backend.repoInfo(`gl-${id}`)).toBeNull();
    expect((await errorOf(backend.resolveRef(`gl-${id}`, 'main')))?.code).toBe('repo_not_found');
    expect((await errorOf(backend.gitRemote(`gl-${id}`, 'read')))?.code).toBe('repo_not_found');
    expect((await errorOf(backend.readFile(`gl-${id}`, 'main', 'a.md')))?.code).toBe('repo_not_found');
  });

  it('does not take a sibling group with the same prefix for the fronted namespace', async () => {
    const gitlab = fakeGitLab();
    const id = await plantProject(gitlab.state, 'raw-content', `${CUSTOMERS}-archive/acme`);
    expect(await backendFor(gitlab).repoInfo(`gl-${id}`)).toBeNull();
  });

  it('answers repo_not_found for a missing project id', async () => {
    const gitlab = fakeGitLab();
    expect((await errorOf(backendFor(gitlab).resolveRef('gl-999999', 'main')))?.code).toBe('repo_not_found');
  });

  it('refuses to create or delete a reserved name with invalid_input, before calling GitLab', async () => {
    const gitlab = fakeGitLab();
    const id = await plantProject(gitlab.state, 'raw-content', `${CUSTOMERS}/acme`);
    const backend = backendFor(gitlab);
    const before = gitlab.state.requests.length;
    expect((await errorOf(backend.createRepo(`gl-${id + 1}`)))?.code).toBe('invalid_input');
    expect((await errorOf(backend.deleteRepo(`gl-${id}`)))?.code).toBe('invalid_input');
    expect(gitlab.state.requests).toHaveLength(before);
    expect(gitlab.state.projects.has('raw-content')).toBe(true);
  });

  it('keeps ordinary names in its own group, including ones that only look reserved', async () => {
    const gitlab = fakeGitLab();
    const backend = backendFor(gitlab, 'leed-');
    await backend.createRepo('gl-12');
    expect((await backend.repoInfo('gl-12'))?.name).toBe('gl-12');
    expect(gitlab.state.requests).toContain(`GET /projects/${encodeURIComponent('acme/sites/gl-12')}`);
    await backend.deleteRepo('gl-12');
    expect(await backend.repoInfo('gl-12')).toBeNull();
  });

  it('treats reserved names as ordinary when frontedProjects is not configured', async () => {
    const gitlab = fakeGitLab();
    const backend = new GitLabBackend({
      baseUrl: gitlab.state.base,
      token: gitlab.state.token,
      namespace: gitlab.state.group.fullPath,
      fetch: gitlab.fetch,
    });
    const created = await backend.createRepo('gl-7');
    expect(created.name).toBe('gl-7');
  });
});
