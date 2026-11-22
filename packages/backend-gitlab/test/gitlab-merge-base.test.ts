// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { describe, expect, it } from 'vite-plus/test';

import { GitLabBackend } from '../src/gitlab-backend.ts';

const OLD = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const NEW = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A GitLabBackend whose merge-base call answers `answer`; every request path is recorded. */
function scripted(answer: () => Response): { backend: GitLabBackend; seen: string[] } {
  const seen: string[] = [];
  const backend = new GitLabBackend({
    baseUrl: 'https://g.example',
    token: 'glpat-test',
    namespace: 'acme',
    fetch: async (request) => {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname.replace(/^\/api\/v4/, '')}?${url.searchParams.toString()}`);
      return answer();
    },
  });
  return { backend, seen };
}

describe('GitLabBackend.isAncestor', () => {
  it('asks the merge-base API once with both ids, and is true exactly when the base is the ancestor', async () => {
    const { backend, seen } = scripted(() => json(200, { id: OLD, parent_ids: [] }));
    expect(await backend.isAncestor('r', OLD, NEW)).toBe(true);
    expect(seen).toEqual([
      `GET /projects/acme%2Fr/repository/merge_base?refs%5B%5D=${OLD}&refs%5B%5D=${NEW}`,
    ]);
    const other = scripted(() => json(200, { id: NEW, parent_ids: [] }));
    expect(await other.backend.isAncestor('r', OLD, NEW)).toBe(false);
  });

  it('is false without a merge base and null when GitLab cannot find a commit', async () => {
    const unrelated = scripted(() => json(404, { message: '404 Merge Base Not Found' }));
    expect(await unrelated.backend.isAncestor('r', OLD, NEW)).toBe(false);
    const unknown = scripted(() => json(400, { message: `Could not find ref: ${OLD}` }));
    expect(await unknown.backend.isAncestor('r', OLD, NEW)).toBeNull();
  });

  it('maps a missing project to repo_not_found and anything else to storage_unavailable', async () => {
    const missing = scripted(() => json(404, { message: '404 Project Not Found' }));
    await expect(missing.backend.isAncestor('r', OLD, NEW)).rejects.toSatisfy(
      (error) => readGatewayError(error)?.code === 'repo_not_found',
    );
    for (const answer of [
      () => json(404, { message: '404 Not Found' }),
      () => json(500, { message: 'boom' }),
    ]) {
      await expect(scripted(answer).backend.isAncestor('r', OLD, NEW)).rejects.toSatisfy(
        (error) => readGatewayError(error)?.code === 'storage_unavailable',
      );
    }
  });

  it('refuses invalid ids as invalid_input without a request', async () => {
    const { backend, seen } = scripted(() => json(200, {}));
    await expect(backend.isAncestor('r', 'HEAD', NEW)).rejects.toSatisfy(
      (error) => readGatewayError(error)?.code === 'invalid_input',
    );
    expect(seen).toEqual([]);
  });
});
