// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { GitLabApi, GitLabHttpError } from '../src/gitlab-api.ts';

const answer =
  (status: number, body: string): ((request: Request) => Promise<Response>) =>
  async () =>
    new Response(body, { status });

async function failure(api: GitLabApi): Promise<GitLabHttpError> {
  try {
    await api.request('/projects/x');
  } catch (error) {
    if (error instanceof GitLabHttpError) return error;
  }
  throw new Error('expected a GitLabHttpError');
}

describe('GitLabApi', () => {
  it('sends the token, query and JSON body, and parses JSON with a schema', async () => {
    const seen: Request[] = [];
    const api = new GitLabApi('https://gitlab.example.com/', 'glpat-x', async (request) => {
      seen.push(request.clone());
      return new Response(JSON.stringify({ id: 7 }));
    });
    expect(
      await api.json(z.object({ id: z.number() }), '/projects', {
        method: 'POST',
        query: { a: 1, b: true },
        body: { name: 'n' },
      }),
    ).toEqual({ id: 7 });
    const request = seen[0];
    expect(request?.url).toBe('https://gitlab.example.com/api/v4/projects?a=1&b=true');
    expect(request?.headers.get('PRIVATE-TOKEN')).toBe('glpat-x');
    expect(request?.headers.get('Content-Type')).toBe('application/json');
    expect(await request?.json()).toEqual({ name: 'n' });
  });

  it('flattens string, validation and error-only bodies into the error detail', async () => {
    expect(
      (await failure(new GitLabApi('https://g', 't', answer(404, '{"message":"404 Project Not Found"}'))))
        .projectMissing,
    ).toBe(true);
    const taken = await failure(
      new GitLabApi(
        'https://g',
        't',
        answer(400, '{"message":{"path":["has already been taken"],"name":["is bad","too long"]}}'),
      ),
    );
    expect(taken.detail).toBe('path has already been taken; name is bad, too long');
    expect(taken.status).toBe(400);
    expect(
      (await failure(new GitLabApi('https://g', 't', answer(403, '{"error":"insufficient_scope"}')))).detail,
    ).toBe('insufficient_scope');
    expect(
      (await failure(new GitLabApi('https://g', 't', answer(502, '<html>bad gateway</html>')))).detail,
    ).toBe('<html>bad gateway</html>');
    expect((await failure(new GitLabApi('https://g', 't', answer(500, '{}')))).detail).toBe('no message');
    const branch = await failure(
      new GitLabApi('https://g', 't', answer(404, '{"message":"404 Branch Not Found"}')),
    );
    expect(branch.projectMissing).toBe(false);
    expect(branch.message).not.toContain('t,');
  });

  it('returns bytes, null for a 404 inside the project, and throws for a missing project', async () => {
    expect(await new GitLabApi('https://g', 't', answer(200, 'abc')).bytesOrNull('/x')).toEqual(
      new TextEncoder().encode('abc'),
    );
    expect(
      await new GitLabApi('https://g', 't', answer(404, '{"message":"404 File Not Found"}')).bytesOrNull(
        '/x',
      ),
    ).toBeNull();
    await expect(
      new GitLabApi('https://g', 't', answer(404, '{"message":"404 Project Not Found"}')).bytesOrNull('/x'),
    ).rejects.toBeInstanceOf(GitLabHttpError);
  });
});
