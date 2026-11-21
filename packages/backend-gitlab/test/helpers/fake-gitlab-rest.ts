// SPDX-License-Identifier: Apache-2.0
import type { FakeGitLabState } from './fake-gitlab.ts';

/** The full path of a project's group. */
export function namespaceOf(state: FakeGitLabState, path: string): string {
  return state.projects.get(path)?.namespace ?? state.group.fullPath;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = (what: string): Response => json(404, { message: `404 ${what} Not Found` });
const raw = (bytes: Uint8Array): Response =>
  new Response(bytes, { status: 200, headers: { 'Content-Type': 'text/plain' } });

function projectJson(state: FakeGitLabState, path: string): unknown {
  const project = state.projects.get(path);
  return {
    id: project?.id,
    path,
    path_with_namespace: `${namespaceOf(state, path)}/${path}`,
    default_branch: project?.defaultBranch,
    created_at: project?.createdAt,
    http_url_to_repo: `${state.base}/${namespaceOf(state, path)}/${path}.git`,
    marked_for_deletion_on: null,
    visibility: 'private',
  };
}

/** The project a "/projects/:id" path names, by numeric id or URL-encoded full path. */
function projectOf(state: FakeGitLabState, id: string): string | null {
  const decoded = decodeURIComponent(id);
  for (const [path, project] of state.projects) {
    if (String(project.id) === decoded || `${project.namespace ?? state.group.fullPath}/${path}` === decoded)
      return path;
  }
  return null;
}

async function createProject(state: FakeGitLabState, request: Request): Promise<Response> {
  const body: unknown = await request.json();
  const path = String(Reflect.get(Object(body), 'path'));
  if (Reflect.get(Object(body), 'namespace_id') !== state.group.id)
    return json(400, { message: { namespace: ['is not valid'] } });
  if (state.projects.has(path))
    return json(400, { message: { name: ['has already been taken'], path: ['has already been taken'] } });
  const defaultBranch = String(Reflect.get(Object(body), 'default_branch') ?? 'main');
  await state.memory.createRepo(path, { defaultBranch });
  state.nextId += 1;
  state.projects.set(path, { id: state.nextId, createdAt: new Date().toISOString(), defaultBranch });
  return json(201, projectJson(state, path));
}

async function repositoryRoute(
  state: FakeGitLabState,
  project: string,
  rest: string,
  url: URL,
): Promise<Response> {
  const memory = state.memory;
  const ref = /^repository\/(branches|tags)\/(.+)$/.exec(rest);
  if (ref !== null) {
    const name = decodeURIComponent(ref[2] ?? '');
    const sha = await memory.resolveRef(project, ref[1] === 'tags' ? `refs/tags/${name}` : name);
    return sha === null
      ? notFound(ref[1] === 'tags' ? 'Tag' : 'Branch')
      : json(200, { name, commit: { id: sha } });
  }
  const commit = /^repository\/commits\/([0-9a-f]{40})$/.exec(rest);
  if (commit !== null) {
    const found = await memory.readCommit(project, commit[1] ?? '');
    return found === null
      ? notFound('Commit')
      : json(200, { id: found.sha, parent_ids: found.parents, title: found.message });
  }
  const blob = /^repository\/blobs\/([0-9a-f]{40})\/raw$/.exec(rest);
  if (blob !== null) {
    const bytes = await memory.readBlob(project, blob[1] ?? '');
    return bytes === null ? notFound('Blob') : raw(bytes);
  }
  const file = /^repository\/files\/(.+)\/raw$/.exec(rest);
  if (file !== null) {
    const bytes = await memory
      .readFile(project, url.searchParams.get('ref') ?? 'main', decodeURIComponent(file[1] ?? ''))
      .catch(() => null);
    return bytes === null ? notFound('File') : raw(bytes);
  }
  if (rest === 'repository/commits') {
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '20');
    const refName = url.searchParams.get('ref_name') ?? 'main';
    const commits = await memory
      .log(project, refName, { limit: perPage, offset: (page - 1) * perPage })
      .catch(() => []);
    return json(
      200,
      commits.map((entry) => ({ id: entry.sha, parent_ids: entry.parents })),
    );
  }
  return notFound('Route');
}

/** Answers one REST API request of the fake GitLab. */
export async function answerRest(state: FakeGitLabState, request: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice('/api/v4/'.length);
  if (request.method === 'GET' && path === `groups/${encodeURIComponent(state.group.fullPath)}`) {
    return json(200, { id: state.group.id, full_path: state.group.fullPath });
  }
  if (request.method === 'POST' && path === 'projects') return createProject(state, request);
  const match = /^projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (match === null) return notFound('Route');
  const project = projectOf(state, match[1] ?? '');
  if (project === null) return notFound('Project');
  const rest = match[2] ?? '';
  if (rest === '' && request.method === 'GET') return json(200, projectJson(state, project));
  if (rest === '' && request.method === 'DELETE') {
    state.projects.delete(project);
    await state.memory.deleteRepo(project);
    return json(202, { message: '202 Accepted' });
  }
  return repositoryRoute(state, project, rest, url);
}
