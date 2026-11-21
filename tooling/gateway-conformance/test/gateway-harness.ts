// SPDX-License-Identifier: Apache-2.0
import { webcrypto } from 'node:crypto';

import { JwtAuthenticator } from '@leed-ai/git-gateway-auth-jwt/jwt-authenticator';
import { createGatewayApp } from '@leed-ai/git-gateway-worker/gateway-app';
import { RuleBranchPolicy } from '@leed-ai/git-gateway-worker/policy/rule-branch-policy';
import type { SyncBranchWorkflowParams } from '@leed-ai/git-gateway-worker/workflows/sync-workflow-schemas';
import type { WorkflowStarter } from '@leed-ai/git-gateway-worker/workflows/workflow-starter';

import { GitSandbox, type GitRun } from '@leed-ai/git-gateway-testkit/git-sandbox';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { serveStreaming } from '@leed-ai/git-gateway-testkit/node/serve-streaming';
import type { LocalServer } from '@leed-ai/git-gateway-testkit/node/serve-fetch-handler';

const ISSUER = 'https://auth.conformance.test';
const AUDIENCE = 'git.conformance.test';
/** The message the protected-branch rule gives; conformance checks git prints it. */
export const PROTECTED_MESSAGE = 'main is protected: maintainers may push, never by force';

const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('base64url');

/** Bytes the gateway holds between taking them in and passing them on, at most, per direction. */
export class InFlight {
  #in = 0;
  #out = 0;
  max = 0;

  took(bytes: number): void {
    this.#in += bytes;
    this.max = Math.max(this.max, this.#in - this.#out);
  }

  passed(bytes: number): void {
    this.#out += bytes;
  }

  reset(): void {
    this.#in = 0;
    this.#out = 0;
    this.max = 0;
  }
}

/** Re-chunks a body into 64 KiB pieces pulled on demand, as a network would deliver it, counting each. */
function rechunk(
  body: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pending.length === 0) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          pending = next.value;
        }
        const piece = pending.subarray(0, 65_536);
        pending = pending.subarray(piece.length);
        onChunk(piece.length);
        controller.enqueue(piece);
      },
    },
    { highWaterMark: 0 },
  );
}

/** A running gateway over the in-memory backend, with JWT credentials and git clients to drive it. */
export interface GatewayHarness {
  readonly url: string;
  readonly backend: MemoryBackend;
  readonly sandbox: GitSandbox;
  /** Tokens by principal: alice (maintainer), bob (editor), reader (read-only), expired (alice, expired). */
  readonly tokens: Readonly<Record<'alice' | 'bob' | 'reader' | 'expired', string>>;
  /** SyncBranchWorkflow instances the main→staging sync rule started, by instance id. */
  readonly syncs: Map<string, SyncBranchWorkflowParams>;
  /** Log entry messages the gateway wrote, in order. */
  readonly logs: string[];
  /** Push bytes: from the client socket to the storage host. */
  readonly pushFlight: InFlight;
  /** Fetch bytes: from the storage host to the client socket. */
  readonly fetchFlight: InFlight;
  /** Creates a repository on the backend and returns its URL at the gateway. */
  repo(name: string): Promise<string>;
  /** Runs git as `who` (its token supplied by a credential helper after the gateway's 401). */
  git(who: keyof GatewayHarness['tokens'] | null, args: readonly string[], cwd?: string): Promise<GitRun>;
  close(): Promise<void>;
}

async function signer(): Promise<{
  jwks: unknown;
  sign: (claims: Record<string, unknown>) => Promise<string>;
}> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwks: {
      keys: [
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: 'conformance', alg: 'ES256', use: 'sig' },
      ],
    },
    sign: async (claims) => {
      const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: 'conformance', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
      const signature = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        Buffer.from(input),
      );
      return `${input}.${b64url(new Uint8Array(signature))}`;
    },
  };
}

/** Starts the gateway on loopback, streaming, in front of a fresh in-memory backend. */
export async function startGatewayHarness(): Promise<GatewayHarness> {
  const backend = new MemoryBackend();
  const sandbox = new GitSandbox();
  const logs: string[] = [];
  const pushFlight = new InFlight();
  const fetchFlight = new InFlight();
  const keys = await signer();
  const now = Math.floor(Date.now() / 1000);
  const token = async (sub: string, roles: string[], exp: number): Promise<string> =>
    keys.sign({ iss: ISSUER, aud: AUDIENCE, sub, roles, exp });
  const tokens = {
    alice: await token('alice', ['maintainer'], now + 3600),
    bob: await token('bob', ['editor'], now + 3600),
    reader: await token('reader', ['reader'], now + 3600),
    expired: await token('alice', ['maintainer'], now - 3600),
  };
  const syncs = new Map<string, SyncBranchWorkflowParams>();
  const syncWorkflow: WorkflowStarter<SyncBranchWorkflowParams> = {
    create: async ({ id, params }) => {
      if (syncs.has(id)) throw new Error(`instance ${id} already exists`);
      syncs.set(id, params);
      return { id };
    },
    get: async (id) => ({ id, status: async () => ({ status: 'queued' }), restart: async () => undefined }),
  };
  const app = createGatewayApp({
    backend,
    gateway: { syncRules: [{ from: 'main', into: 'staging' }] },
    syncWorkflow,
    authenticator: new JwtAuthenticator(
      { issuer: ISSUER, audience: [AUDIENCE], jwksUrl: `${ISSUER}/jwks.json` },
      { fetch: async () => Response.json(keys.jwks) },
    ),
    authorizer: {
      authorize: async (principal, _repo, operation) =>
        operation === 'read' || !principal.roles.includes('reader'),
    },
    branchPolicy: new RuleBranchPolicy({
      rules: [
        { pattern: 'refs/heads/main', pushers: { roles: ['maintainer'] }, message: PROTECTED_MESSAGE },
        { pattern: 'refs/heads/feature/**', forcePush: true, delete: true },
      ],
    }),
    logger: { log: (entry) => logs.push(entry.message) },
    fetch: async (request) => {
      const body = request.body === null ? null : rechunk(request.body, (bytes) => pushFlight.passed(bytes));
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers: request.headers };
      if (body !== null) {
        init.body = body;
        init.duplex = 'half';
      }
      const response = await backend.fetch(new Request(request.url, init));
      if (response.body === null) return response;
      return new Response(
        rechunk(response.body, (bytes) => fetchFlight.took(bytes)),
        response,
      );
    },
  });
  const server: LocalServer = await serveStreaming(async (request) => app.fetch(request), {
    onRequestChunk: (bytes) => pushFlight.took(bytes),
    onResponseChunk: (bytes) => fetchFlight.passed(bytes),
  });
  return {
    url: server.url,
    backend,
    syncs,
    sandbox,
    tokens,
    logs,
    pushFlight,
    fetchFlight,
    async repo(name) {
      await backend.createRepo(name);
      return `${server.url}/${name}.git`;
    },
    async git(who, args, cwd) {
      const helper =
        who === null
          ? []
          : [`credential.helper=!f() { echo username=git; echo password=${tokens[who]}; }; f`];
      return sandbox.run(args, {
        config: ['credential.helper=', ...helper],
        ...(cwd === undefined ? {} : { cwd }),
      });
    },
    async close() {
      await server.close();
      sandbox.dispose();
    },
  };
}
