// SPDX-License-Identifier: Apache-2.0
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

import type { GatewayContext } from './gateway-context.ts';

/** What became of one pushed ref update. */
export type PushOutcome =
  | { readonly status: 'ok' }
  /** The host refused the update: normally because the ref no longer names `oldSha`. */
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Pushes one ref update with the objects it needs, in one git-receive-pack request through a
 * freshly minted write remote. The update names the old id, so the host refuses it when the ref
 * moved in the meantime: nothing is ever overwritten and nothing is forced. Transport failures
 * and a pack the host could not unpack throw storage_unavailable; the credential never leaves
 * this function. An accepted update is passed to the deployment's onPush hook.
 */
export async function pushRefUpdate(
  context: GatewayContext,
  repo: string,
  update: RefUpdate,
  objects: readonly GitObject[],
): Promise<PushOutcome> {
  const remote = await context.backend.gitRemote(repo, 'write');
  const client = new GitHttpClient(remote, context.fetch === undefined ? {} : { fetch: context.fetch });
  let report;
  try {
    report = await client.push([update], objects);
  } catch (thrown) {
    if (isCoreError(thrown)) throw storageUnavailable(`push to ${update.ref}`, thrown);
    throw thrown;
  }
  if (report.unpack !== 'ok') throw storageUnavailable(`push to ${update.ref}`, `unpack ${report.unpack}`);
  const status = report.refs.find((entry) => entry.ref === update.ref);
  if (status === undefined) throw storageUnavailable(`push to ${update.ref}`, 'no status for the ref');
  if (status.status !== 'ok') return { status: 'refused', reason: status.reason };
  await notifyPush(context, repo, update);
  return { status: 'ok' };
}

/** Tells the deployment's onPush hook about an accepted update; a hook failure is reported, not thrown. */
async function notifyPush(context: GatewayContext, repo: string, update: RefUpdate): Promise<void> {
  if (context.onPush === undefined) return;
  try {
    await context.onPush({ repo, updates: [update], pushedAt: context.now().toISOString() });
  } catch (error) {
    context.onPushError(error);
  }
}
