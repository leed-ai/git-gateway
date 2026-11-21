// SPDX-License-Identifier: Apache-2.0
import type { RpcOutput, RpcParsedInput } from '@leed-ai/git-gateway-contract/git-gateway';
import { remoteUrlOf } from '@leed-ai/git-gateway-contract/reference/repo-state';

import type { GatewayContext } from './gateway-context.ts';
import { mintReadToken } from './read-token.ts';
import { requireRepo } from './repo-access.ts';

/** createRepo(): an empty repository on the backend; repo_exists when the name is taken. */
export async function gatewayCreateRepo(
  context: GatewayContext,
  { repo, defaultBranch }: RpcParsedInput<'createRepo'>,
): Promise<RpcOutput<'createRepo'>> {
  const info = await context.backend.createRepo(repo, { defaultBranch });
  return {
    name: info.name,
    defaultBranch: info.defaultBranch,
    // A host that does not report creation times created the repository just now.
    createdAt: info.createdAt ?? context.now().toISOString(),
    remoteUrl: remoteUrlOf(context.config, info.name),
  };
}

/** deleteRepo(): deletes the repository; `deleted` is false when there was none. */
export async function gatewayDeleteRepo(
  context: GatewayContext,
  { repo }: RpcParsedInput<'deleteRepo'>,
): Promise<RpcOutput<'deleteRepo'>> {
  if ((await context.backend.repoInfo(repo)) === null) return { deleted: false };
  await context.backend.deleteRepo(repo);
  return { deleted: true };
}

/**
 * mintReadToken(): a signed, short-lived credential that reads one repository through the
 * gateway (see `verifyReadToken`). It is not a storage-host credential and grants no write.
 */
export async function gatewayMintReadToken(
  context: GatewayContext,
  { repo, ttlSeconds }: RpcParsedInput<'mintReadToken'>,
): Promise<RpcOutput<'mintReadToken'>> {
  await requireRepo(context, repo);
  const minted = await mintReadToken({
    repo,
    ttlSeconds,
    secret: context.readTokenSecret,
    now: context.now(),
  });
  return { ...minted, remoteUrl: remoteUrlOf(context.config, repo) };
}
