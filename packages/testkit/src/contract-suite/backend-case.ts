// SPDX-License-Identifier: Apache-2.0
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { GitHttpClient, type FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

/** How a storage host treats pushes the contract leaves to the host. */
export interface HostBehaviour {
  /**
   * A push whose update names the ref's current id but does not contain it (a non-fast-forward
   * update sent with force): "accepted" (git's default on a bare repository) or "refused".
   */
  readonly nonFastForward: 'accepted' | 'refused';
  /** gitRemote(…, "read") yields a credential that cannot push. */
  readonly readRemoteCannotPush: boolean;
}

/** Everything a backend contract case runs with. */
export interface BackendContext {
  readonly backend: StorageBackend;
  /** A repository name no other case uses. The case creates it unless it tests creation. */
  readonly repo: string;
  readonly behaviour: HostBehaviour;
  /** Size of the large-file case's file in bytes. */
  readonly largeFileBytes: number;
  /** A smart-HTTP client for a freshly minted remote of the case's repository. */
  client(access: GitAccess): Promise<GitHttpClient>;
}

/** One rule of the storage backend contract. */
export interface BackendCase {
  readonly group: string;
  readonly name: string;
  readonly run: (context: BackendContext) => Promise<void>;
}

/** Declares a backend contract case. */
export function backendCase(
  group: string,
  name: string,
  run: (context: BackendContext) => Promise<void>,
): BackendCase {
  return { group, name, run };
}

/** A client factory for a backend's remotes, sending requests through `fetch`. */
export function clientFactory(
  backend: StorageBackend,
  repo: string,
  fetch: FetchLike | undefined,
): (access: GitAccess) => Promise<GitHttpClient> {
  return async (access) =>
    new GitHttpClient(await backend.gitRemote(repo, access), fetch === undefined ? {} : { fetch });
}
