// SPDX-License-Identifier: Apache-2.0
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { readAllBytes } from '@leed-ai/git-gateway-core/bytes';

import type { MemoryRepository } from './memory-repository.ts';
import { credentialOf, type MemoryTokens } from './memory-tokens.ts';
import { answerReceivePack, receivePackAdvertisement } from './receive-pack-service.ts';
import { answerUploadPack, uploadPackAdvertisement } from './upload-pack-service.ts';

const ROUTE = /^\/(?<repo>[^/]+)\.git\/(?<rest>info\/refs|git-upload-pack|git-receive-pack)$/;
const NO_CACHE = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' };

/** What the smart-HTTP server needs from the backend. */
export interface SmartHttpHost {
  readonly tokens: MemoryTokens;
  repository(name: string): MemoryRepository | undefined;
}

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

function gitResponse(body: Uint8Array, type: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': type, ...NO_CACHE } });
}

async function requestBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array(0);
  const encoding = request.headers.get('Content-Encoding');
  const stream =
    encoding === 'gzip' ? request.body.pipeThrough(new DecompressionStream('gzip')) : request.body;
  return readAllBytes(stream);
}

/** Checks the request's credential opens `repo` for `access`; returns an error response when not. */
function authorize(host: SmartHttpHost, request: Request, repo: string, access: GitAccess): Response | null {
  const credential = credentialOf(request);
  const grant = credential === null ? null : host.tokens.check(credential);
  if (grant?.repo !== repo) {
    return text(401, 'authentication required\n', {
      'WWW-Authenticate': 'Basic realm="git-gateway-testkit"',
    });
  }
  if (access === 'write' && grant.access !== 'write') return text(403, 'read-only credential\n');
  return null;
}

/**
 * Serves git smart HTTP (protocol v0/v1) for the in-memory repositories: GET
 * /<repo>.git/info/refs?service=…, POST /<repo>.git/git-upload-pack and
 * /git-receive-pack. Every request needs a token minted by gitRemote() for that repository —
 * as a Bearer header or the password of HTTP Basic — and a read token cannot push.
 */
export async function serveSmartHttp(host: SmartHttpHost, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  const name = match?.groups?.['repo'];
  const rest = match?.groups?.['rest'];
  if (name === undefined || rest === undefined) return text(404, 'not found\n');
  const service = rest === 'info/refs' ? url.searchParams.get('service') : rest;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return text(403, 'dumb HTTP is not supported\n');
  }
  const denied = authorize(host, request, name, service === 'git-receive-pack' ? 'write' : 'read');
  if (denied !== null) return denied;
  const repo = host.repository(name);
  if (repo === undefined) return text(404, 'repository not found\n');
  if (rest === 'info/refs') {
    if (request.method !== 'GET') return text(405, 'method not allowed\n');
    const body =
      service === 'git-upload-pack' ? uploadPackAdvertisement(repo) : receivePackAdvertisement(repo);
    return gitResponse(body, `application/x-${service}-advertisement`);
  }
  if (request.method !== 'POST') return text(405, 'method not allowed\n');
  const body = await requestBody(request);
  const answer =
    service === 'git-upload-pack' ? await answerUploadPack(repo, body) : await answerReceivePack(repo, body);
  return gitResponse(answer, `application/x-${service}-result`);
}
