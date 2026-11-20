// SPDX-License-Identifier: Apache-2.0
import { RPC_SCHEMAS, type RpcInput, type RpcOutput } from '../git-gateway.ts';
import { gatewayError } from '../gateway-error.ts';
import { utf8 } from './bytes.ts';
import { sha1Hex } from './hash.ts';
import { remoteUrlOf, requireRepo, type ReferenceContext } from './repo-state.ts';
import { runMethod } from './run-method.ts';

/** The reference `createRepo`. */
export function referenceCreateRepo(
  context: ReferenceContext,
  input: RpcInput<'createRepo'>,
): Promise<RpcOutput<'createRepo'>> {
  return runMethod(RPC_SCHEMAS.createRepo, input, async ({ repo, defaultBranch }) => {
    if (context.repos.has(repo))
      throw gatewayError('repo_exists', `Repository already exists: ${repo}`, { repo });
    const createdAt = context.now().toISOString();
    context.repos.set(repo, {
      name: repo,
      defaultBranch,
      createdAt,
      branches: new Map(),
      commits: new Map(),
      lock: Promise.resolve(),
    });
    return { name: repo, defaultBranch, createdAt, remoteUrl: remoteUrlOf(context.config, repo) };
  });
}

/** The reference `deleteRepo`. */
export function referenceDeleteRepo(
  context: ReferenceContext,
  input: RpcInput<'deleteRepo'>,
): Promise<RpcOutput<'deleteRepo'>> {
  return runMethod(RPC_SCHEMAS.deleteRepo, input, async ({ repo }) => ({
    deleted: context.repos.delete(repo),
  }));
}

/** The reference `mintReadToken`: an opaque, deterministic token (it authorizes nothing in memory). */
export function referenceMintReadToken(
  context: ReferenceContext,
  input: RpcInput<'mintReadToken'>,
): Promise<RpcOutput<'mintReadToken'>> {
  return runMethod(RPC_SCHEMAS.mintReadToken, input, async ({ repo, ttlSeconds }) => {
    requireRepo(context, repo);
    const now = context.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const token = `ggr_${await sha1Hex(utf8(`${repo}\0${now.toISOString()}\0${expiresAt}`))}`;
    return { token, expiresAt, remoteUrl: remoteUrlOf(context.config, repo) };
  });
}
