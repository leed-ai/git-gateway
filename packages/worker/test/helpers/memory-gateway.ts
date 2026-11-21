// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '@leed-ai/git-gateway-contract/git-gateway';
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';

import { gatewayContext, type GatewayContext, type GatewayOptions } from '../../src/rpc/gateway-context.ts';
import { createGatewayRpc } from '../../src/rpc/gateway-rpc.ts';

/** The read-token secret every test gateway signs with. */
export const SECRET = 'test-read-token-secret-0123456789abcdef';

/** The author test commits are made as. */
export const AUTHOR = { name: 'Test Author', email: 'author@example.com' };

/** A gateway over an in-memory backend, with the context its methods run in. */
export interface MemoryGateway {
  readonly backend: MemoryBackend;
  readonly gateway: GitGateway;
  readonly context: GatewayContext;
}

/** A gateway over a fresh (or the given) in-memory backend, pushing through the backend's own handler. */
export function memoryGateway(
  overrides: Partial<GatewayOptions> = {},
  backend: MemoryBackend = new MemoryBackend(),
): MemoryGateway {
  const options: GatewayOptions = { backend, readTokenSecret: SECRET, fetch: backend.fetch, ...overrides };
  return { backend, gateway: createGatewayRpc(options), context: gatewayContext(options) };
}

/** True for a git-receive-pack POST (a push). */
export const isPush = (request: Request): boolean =>
  request.method === 'POST' && new URL(request.url).pathname.endsWith('/git-receive-pack');

/**
 * A fetch that runs `beforePush` before each of the first `races` pushes reach the backend, so a
 * competing write can move the branch between the gateway's read of the head and its push.
 */
export function racingFetch(
  backend: MemoryBackend,
  races: number,
  beforePush: (index: number) => Promise<void>,
): FetchLike & { readonly pushes: () => number } {
  let pushes = 0;
  const fetch = async (request: Request): Promise<Response> => {
    if (isPush(request)) {
      pushes += 1;
      if (pushes <= races) await beforePush(pushes);
    }
    return backend.fetch(request);
  };
  return Object.assign(fetch, { pushes: () => pushes });
}

let counter = 0;

/** A unique idempotency key. */
export function key(label = 'k'): string {
  counter += 1;
  return `${label}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Commits upserts (null deletes) to a branch and returns the new head, failing unless it committed. */
export async function write(
  gateway: GitGateway,
  repo: string,
  branch: string,
  files: Record<string, string | null>,
  extra: { startBranch?: string } = {},
): Promise<string> {
  const actions: CommitActionInput[] = Object.entries(files).map(([path, content]) =>
    content === null ? { action: 'delete', path } : { action: 'upsert', path, content },
  );
  const output = await gateway.commit({
    repo,
    branch,
    actions,
    message: `Change ${branch}`,
    author: AUTHOR,
    idempotencyKey: key(),
    ...extra,
  });
  if (output.status !== 'committed') throw new Error(`expected a commit, got ${output.status}`);
  return output.commit.sha;
}

/** Creates a repository with `main` holding the files; returns the head of main. */
export async function seed(
  gateway: GitGateway,
  repo: string,
  files: Record<string, string> = { 'README.md': '# Seed\n' },
): Promise<string> {
  await gateway.createRepo({ repo });
  return write(gateway, repo, 'main', files);
}

/** Every commit message on a branch, newest first. */
export async function messages(gateway: GitGateway, repo: string, branch: string): Promise<string[]> {
  const log = await gateway.log({ repo, ref: branch, limit: 500 });
  return log.commits.map((commit) => commit.message);
}
