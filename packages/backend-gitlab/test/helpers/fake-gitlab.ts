// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';

import { answerRest, namespaceOf } from './fake-gitlab-rest.ts';

/** The state of a fake GitLab instance: one group whose projects live in a MemoryBackend. */
export interface FakeGitLabState {
  readonly base: string;
  readonly token: string;
  readonly group: { readonly id: number; readonly fullPath: string };
  readonly memory: MemoryBackend;
  /**
   * Projects by path. A project with a `namespace` lives in that group instead of the fake's own
   * (an existing project the backend fronts by id); its path must still be unique in the map.
   */
  readonly projects: Map<
    string,
    { id: number; createdAt: string; defaultBranch: string; namespace?: string }
  >;
  nextId: number;
  /** Every API request seen, as "METHOD /path?query", for assertions. */
  readonly requests: string[];
}

/** A fake GitLab instance: enough of the REST API (v4) and git smart HTTP to drive the backend. */
export interface FakeGitLab {
  readonly state: FakeGitLabState;
  readonly fetch: FetchLike;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers git requests for "<namespace>/<project>.git/…", checking the token and forwarding to the memory backend. */
async function answerGit(state: FakeGitLabState, request: Request, path: string): Promise<Response> {
  const project = [...state.projects.keys()].find((candidate) =>
    path.startsWith(`/${namespaceOf(state, candidate)}/${candidate}.git/`),
  );
  const expected = `Basic ${btoa(`oauth2:${state.token}`)}`;
  if (request.headers.get('Authorization') !== expected)
    return new Response('HTTP Basic: Access denied', { status: 401 });
  if (project === undefined) return new Response('not found', { status: 404 });
  const rest = path.slice(`/${namespaceOf(state, project)}/`.length);
  const remote = await state.memory.gitRemote(project, 'write');
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(remote.headers)) headers.set(name, value);
  const forwarded = new Request(`${remote.url}${rest.slice(project.length + 4)}${url.search}`, {
    method: request.method,
    headers,
    ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
  });
  return state.memory.handle(forwarded);
}

/**
 * Plants an existing project `path` in group `namespace` (outside the fake's own group, as a project
 * the backend fronts by id would be) and returns its id.
 */
export async function plantProject(
  state: FakeGitLabState,
  path: string,
  namespace: string,
  defaultBranch = 'main',
): Promise<number> {
  await state.memory.createRepo(path, { defaultBranch });
  state.nextId += 1;
  state.projects.set(path, {
    id: state.nextId,
    createdAt: new Date().toISOString(),
    defaultBranch,
    namespace,
  });
  return state.nextId;
}

/** Removes a project planted with {@link plantProject}. */
export async function removeProject(state: FakeGitLabState, path: string): Promise<void> {
  state.projects.delete(path);
  await state.memory.deleteRepo(path);
}

/** Starts a fake GitLab at `base` with one group, accepting `token`. */
export function fakeGitLab(
  base = 'https://gitlab.example.com',
  token = 'glpat-fake',
  groupPath = 'acme/sites',
): FakeGitLab {
  const state: FakeGitLabState = {
    base,
    token,
    group: { id: 42, fullPath: groupPath },
    memory: new MemoryBackend(),
    projects: new Map(),
    nextId: 1000,
    requests: [],
  };
  const fetch: FetchLike = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== new URL(base).origin) return new Response('wrong host', { status: 502 });
    if (url.pathname.startsWith('/api/v4/')) {
      state.requests.push(`${request.method} ${url.pathname.slice(7)}${url.search}`);
      if (request.headers.get('PRIVATE-TOKEN') !== token) return json(401, { message: '401 Unauthorized' });
      return answerRest(state, request, url);
    }
    if (url.pathname.includes('.git/')) return answerGit(state, request, url.pathname);
    return new Response('not found', { status: 404 });
  };
  return { state, fetch };
}
