// SPDX-License-Identifier: Apache-2.0
import { APIError, Cloudflare } from 'cloudflare';
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import { ArtifactsRestControl } from '../src/artifacts-rest.ts';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const envelope = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
const notFound = (): Response =>
  new Response(
    JSON.stringify({
      success: false,
      result: null,
      errors: [{ code: 10200, message: 'not found' }],
      messages: [],
    }),
    {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    },
  );

const REPO = {
  id: 'r1',
  name: 'acme',
  description: null,
  default_branch: 'main',
  created_at: '2026-11-20T09:30:00Z',
  remote: 'https://a.example/git/ns/acme.git',
};

/** A control plane whose SDK client talks to a scripted fetch, recording requests. */
function control(answer: (seen: Seen) => Response): { rest: ArtifactsRestControl; seen: Seen[] } {
  const seen: Seen[] = [];
  const client = new Cloudflare({
    apiToken: 'test-token',
    maxRetries: 0,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const entry = { method: init?.method ?? 'GET', path: url.pathname.replace('/client/v4', ''), body };
      seen.push(entry);
      return answer(entry);
    },
  });
  return { rest: new ArtifactsRestControl({ client, accountId: 'acct', namespace: 'ns' }), seen };
}

describe('ArtifactsRestControl', () => {
  it('creates, reads and deletes repositories through the SDK', async () => {
    const { rest, seen } = control((entry) =>
      entry.method === 'DELETE' ? envelope({ id: 'r1' }) : envelope({ ...REPO, token: 'secret' }),
    );
    expect(await rest.createRepo('acme', 'main')).toMatchObject({ name: 'acme', default_branch: 'main' });
    expect(await rest.getRepo('acme')).toMatchObject({ remote: REPO.remote });
    expect(await rest.deleteRepo('acme')).toBe(true);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/accounts/acct/artifacts/namespaces/ns/repos',
        body: { name: 'acme', default_branch: 'main' },
      },
      { method: 'GET', path: '/accounts/acct/artifacts/namespaces/ns/repos/acme', body: undefined },
      { method: 'DELETE', path: '/accounts/acct/artifacts/namespaces/ns/repos/acme', body: undefined },
    ]);
  });

  it('answers null or false for missing repositories, namespaces and tokens', async () => {
    const { rest } = control(() => notFound());
    expect(await rest.getRepo('acme')).toBeNull();
    expect(await rest.deleteRepo('acme')).toBe(false);
    expect(await rest.getNamespace()).toBeNull();
    expect(await rest.revokeToken('t1')).toBe(false);
  });

  it('rethrows other API failures', async () => {
    const { rest } = control(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1, message: 'bad' }],
            messages: [],
            result: null,
          }),
          { status: 400 },
        ),
    );
    await expect(rest.getRepo('acme')).rejects.toThrow(APIError);
    await expect(rest.deleteRepo('acme')).rejects.toThrow(APIError);
    await expect(rest.getNamespace()).rejects.toThrow(APIError);
    await expect(rest.revokeToken('t1')).rejects.toThrow(APIError);
  });

  it('manages namespaces and tokens, validating the token lifetime', async () => {
    const { rest, seen } = control((entry) => {
      if (entry.path.endsWith('/tokens'))
        return envelope({ id: 't1', plaintext: 'art_x', scope: 'read', expires_at: '2026-11-20T09:35:00Z' });
      if (entry.path.includes('/tokens/')) return envelope({ id: 't1' });
      return envelope({ name: 'ns', jurisdiction: 'eu' });
    });
    expect(await rest.getNamespace()).toEqual({ name: 'ns' });
    expect(await rest.createNamespace('ns', 'eu')).toEqual({ name: 'ns' });
    expect(await rest.createNamespace('other')).toEqual({ name: 'ns' });
    expect(await rest.createToken('acme', 'read', 300)).toMatchObject({ plaintext: 'art_x' });
    expect(await rest.revokeToken('t1')).toBe(true);
    await expect(rest.createToken('acme', 'read', 10)).rejects.toThrow(ZodError);
    expect(seen.map((entry) => [entry.method, entry.path, entry.body])).toEqual([
      ['GET', '/accounts/acct/artifacts/namespaces/ns', undefined],
      ['POST', '/accounts/acct/artifacts/namespaces', { namespace: 'ns', jurisdiction: 'eu' }],
      ['POST', '/accounts/acct/artifacts/namespaces', { namespace: 'other' }],
      ['POST', '/accounts/acct/artifacts/namespaces/ns/tokens', { repo: 'acme', scope: 'read', ttl: 300 }],
      ['DELETE', '/accounts/acct/artifacts/namespaces/ns/tokens/t1', undefined],
    ]);
  });
});
