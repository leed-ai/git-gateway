// SPDX-License-Identifier: Apache-2.0
import type { GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';

import { NO_CACHE } from './git-responses.ts';
import type { GitRequest } from './git-route.ts';

/** Sends one HTTP request: `fetch`, or a stand-in such as an in-memory backend's handler. */
export type UpstreamFetch = (request: Request) => Promise<Response>;

/** Response headers passed back from the storage host; everything else (cookies, auth challenges) is dropped. */
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma'] as const;

/**
 * The protocol version header to send upstream. Fetches pass it through untouched, so protocol v2
 * reaches a host that speaks it; pushes use protocol v1 receive-pack (which every client and host
 * supports), so a "version=2" request is dropped and the host answers in v0/v1.
 */
function gitProtocol(request: Request, git: GitRequest): string | null {
  const value = request.headers.get('Git-Protocol');
  if (value === null) return null;
  if (git.service === 'git-upload-pack') return value;
  const kept = value
    .split(':')
    .filter((part) => part.trim() !== '' && !/^version=2$/.test(part.trim()))
    .join(':');
  return kept === '' ? null : kept;
}

/**
 * The request to send to the storage host for a client request: the host's URL for the same
 * endpoint, the credential headers minted for this request, and only the client headers the git
 * protocol needs (Content-Type, Accept, Git-Protocol, User-Agent, and Content-Encoding for a
 * fetch). The client's Authorization, cookies and anything else never leave the gateway.
 */
export function upstreamRequest(
  request: Request,
  git: GitRequest,
  remote: GitRemote,
  body: ReadableStream<Uint8Array> | null,
): Request {
  const headers = new Headers();
  for (const name of ['Content-Type', 'Accept', 'User-Agent']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const protocol = gitProtocol(request, git);
  if (protocol !== null) headers.set('Git-Protocol', protocol);
  const encoding = request.headers.get('Content-Encoding');
  if (encoding !== null && git.service === 'git-upload-pack' && body !== null)
    headers.set('Content-Encoding', encoding);
  for (const [name, value] of Object.entries(remote.headers)) headers.set(name, value);
  const base = remote.url.replace(/\/$/, '');
  const url =
    git.endpoint === 'info-refs' ? `${base}/info/refs?service=${git.service}` : `${base}/${git.service}`;
  const init: RequestInit & { duplex?: 'half' } = {
    method: git.endpoint === 'info-refs' ? 'GET' : 'POST',
    headers,
    redirect: 'manual',
  };
  if (body !== null) {
    init.body = body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** The response headers to give the client for a storage host response. */
export function clientHeaders(upstream: Response, requestId: string): Headers {
  const headers = new Headers(NO_CACHE);
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('X-Request-Id', requestId);
  return headers;
}
