// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';

import { answerRest } from './fake-gitlab-rest.ts';

/** The state of a fake GitLab instance: one group whose projects live in a MemoryBackend. */
export interface FakeGitLabState {
  readonly base: string;
  readonly token: string;
  readonly group: { readonly id: number; readonly fullPath: string };
  readonly memory: MemoryBackend;
  readonly projects: Map<string, { id: number; createdAt: string; defaultBranch: string }>;
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

/** Answers git requests for "<group>/<project>.git/…", checking the token and forwarding to the memory backend. */
async function answerGit(state: FakeGitLabState, request: Request, path: string): Promise<Response> {
  const prefix = `/${state.group.fullPath}/`;
  const rest = path.slice(prefix.length);
  const project = rest.slice(0, rest.indexOf('.git/'));
  const expected = `Basic ${btoa(`oauth2:${state.token}`)}`;
  if (request.headers.get('Authorization') !== expected)
    return new Response('HTTP Basic: Access denied', { status: 401 });
  if (!state.projects.has(project)) return new Response('not found', { status: 404 });
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
    if (!url.href.startsWith(base)) return new Response('wrong host', { status: 502 });
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
