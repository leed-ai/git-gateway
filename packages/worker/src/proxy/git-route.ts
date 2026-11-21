// SPDX-License-Identifier: Apache-2.0
import type { GitOperation, SmartHttpEndpoint } from '@leed-ai/git-gateway-contract/proxy/git-operation';
import { RepoName } from '@leed-ai/git-gateway-contract/schemas/names';

/** A git service as named on the wire. */
export type GitServiceName = 'git-upload-pack' | 'git-receive-pack';

/** What a smart-HTTP request addresses. */
export interface GitRequest {
  readonly repo: RepoName;
  readonly endpoint: SmartHttpEndpoint;
  readonly service: GitServiceName;
  readonly operation: GitOperation;
}

/** Why a path is not a smart-HTTP request the gateway serves. */
export type GitRouteFailure = 'not-found' | 'dumb-http';

const PATH = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Resolves `/<repo>.git/info/refs?service=…`, `/<repo>.git/git-upload-pack` and
 * `/<repo>.git/git-receive-pack`. An info/refs request without a smart service is "dumb-http"
 * (unsupported); anything else, including a repository name the contract does not allow, is
 * "not-found".
 */
export function resolveGitRequest(url: URL): GitRequest | GitRouteFailure {
  const match = PATH.exec(url.pathname);
  if (match === null) return 'not-found';
  let name: string;
  try {
    name = decodeURIComponent(match[1] ?? '');
  } catch {
    return 'not-found';
  }
  const repo = RepoName.safeParse(name);
  if (!repo.success) return 'not-found';
  const rest = match[2];
  const service = rest === 'info/refs' ? url.searchParams.get('service') : rest;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return 'dumb-http';
  const endpoint: SmartHttpEndpoint =
    rest === 'info/refs' ? 'info-refs' : service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  return {
    repo: repo.data,
    endpoint,
    service,
    operation: service === 'git-receive-pack' ? 'write' : 'read',
  };
}
