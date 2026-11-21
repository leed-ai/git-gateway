// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Context } from 'hono';

import type { GatewayDeps } from './gateway-deps.ts';
import type { GatewayEnv } from './gateway-env.ts';
import { textResponse } from './git-responses.ts';
import { clientHeaders, upstreamRequest } from './upstream.ts';

/** The storage host's answer, or the response to give the client instead. */
export type UpstreamResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly response: Response; readonly reason: string };

function failed(requestId: string, status: number, reason: string): UpstreamResult {
  return { ok: false, reason, response: textResponse(status, reason, { 'X-Request-Id': requestId }) };
}

/**
 * Mints a git remote for this request from the backend (a fresh short-lived credential each time)
 * and sends the request to the storage host. A 2xx answer comes back as is for the caller to
 * stream; anything else becomes a plain-text error for the client: 404 for a missing repository,
 * 502 when the host refused the gateway's own credential or failed. The host's headers and the
 * credential never reach the client. `body` errors (a refused push) surface as a thrown error.
 */
export async function callUpstream(
  deps: GatewayDeps,
  context: Context<GatewayEnv>,
  body: ReadableStream<Uint8Array> | null,
): Promise<UpstreamResult> {
  const requestId = context.get('requestId');
  const git = context.get('git');
  let remote;
  try {
    remote = await deps.backend.gitRemote(git.repo, git.operation);
  } catch (error) {
    const gatewayError = readGatewayError(error);
    if (gatewayError?.code === 'repo_not_found')
      return failed(requestId, 404, `Repository not found: ${git.repo}`);
    deps.logger.log({
      level: 'error',
      message: 'minting the storage remote failed',
      requestId,
      repo: git.repo,
      error: gatewayError?.code ?? (error instanceof Error ? error.name : 'unknown'),
    });
    return failed(requestId, 502, 'The storage backend is unavailable; try again later');
  }
  const upstream = await deps.fetch(upstreamRequest(context.req.raw, git, remote, body));
  if (upstream.status >= 200 && upstream.status < 300) return { ok: true, response: upstream };
  await upstream.body?.cancel().catch(() => undefined);
  deps.logger.log({
    level: upstream.status === 404 ? 'info' : 'error',
    message: 'storage host refused the request',
    requestId,
    repo: git.repo,
    endpoint: git.endpoint,
    upstreamStatus: upstream.status,
  });
  if (upstream.status === 404) return failed(requestId, 404, `Repository not found: ${git.repo}`);
  return failed(requestId, 502, 'The storage backend failed to answer; try again later');
}

/** The client response for a 2xx storage host response, streamed through untouched. */
export function streamToClient(
  upstream: Response,
  body: ReadableStream<Uint8Array> | null,
  requestId: string,
): Response {
  return new Response(body, { status: upstream.status, headers: clientHeaders(upstream, requestId) });
}
