// SPDX-License-Identifier: Apache-2.0
import type { Cloudflare } from 'cloudflare';
import { z } from 'zod';

import {
  ArtifactsRestNamespace,
  ArtifactsRestRepo,
  ArtifactsRestToken,
  cloudflareEnvelope,
} from './schemas/artifacts-rest-results.ts';

/** Where the REST control plane points: an account and one Artifacts namespace in it. */
export interface ArtifactsRestOptions {
  /** A configured official Cloudflare SDK client (API token with Artifacts permissions). */
  readonly client: Cloudflare;
  readonly accountId: string;
  readonly namespace: string;
}

const NotFound = z.object({ status: z.literal(404) });

/** True when the SDK threw for a 404. */
function isNotFound(error: unknown): boolean {
  return NotFound.safeParse(error).success;
}

/**
 * The Artifacts control plane over the Cloudflare REST API, for code that runs outside a Worker
 * (provisioning scripts, CI, the live contract leg): namespaces, repositories and tokens. Every
 * call goes through the official `cloudflare` SDK's generic request methods (it has no typed
 * Artifacts resource yet) and every response is parsed with Zod. Inside a Worker, use the binding
 * and {@link ArtifactsBackend} instead.
 */
export class ArtifactsRestControl {
  readonly #client: Cloudflare;
  readonly #account: string;
  readonly #namespace: string;

  constructor(options: ArtifactsRestOptions) {
    this.#client = options.client;
    this.#account = `/accounts/${encodeURIComponent(options.accountId)}/artifacts`;
    this.#namespace = `${this.#account}/namespaces/${encodeURIComponent(options.namespace)}`;
  }

  /** The namespace, or null when it does not exist. */
  async getNamespace(): Promise<ArtifactsRestNamespace | null> {
    try {
      return cloudflareEnvelope(ArtifactsRestNamespace).parse(await this.#client.get(this.#namespace)).result;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Creates the namespace (optionally pinned to a jurisdiction). */
  async createNamespace(name: string, jurisdiction?: 'eu' | 'us'): Promise<ArtifactsRestNamespace> {
    const body = jurisdiction === undefined ? { namespace: name } : { namespace: name, jurisdiction };
    return cloudflareEnvelope(ArtifactsRestNamespace).parse(
      await this.#client.post(`${this.#account}/namespaces`, { body }),
    ).result;
  }

  /** Creates a repository; the initial token in the result is not returned. */
  async createRepo(name: string, defaultBranch: string): Promise<ArtifactsRestRepo> {
    const response = await this.#client.post(`${this.#namespace}/repos`, {
      body: { name, default_branch: defaultBranch },
    });
    return cloudflareEnvelope(ArtifactsRestRepo).parse(response).result;
  }

  /** A repository, or null when it does not exist. */
  async getRepo(name: string): Promise<ArtifactsRestRepo | null> {
    try {
      return cloudflareEnvelope(ArtifactsRestRepo).parse(
        await this.#client.get(`${this.#namespace}/repos/${encodeURIComponent(name)}`),
      ).result;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Deletes a repository; false when there was none. */
  async deleteRepo(name: string): Promise<boolean> {
    try {
      await this.#client.delete(`${this.#namespace}/repos/${encodeURIComponent(name)}`);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Mints a repository token for git; `ttlSeconds` 60–31536000. */
  async createToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsRestToken> {
    const body = { repo, scope, ttl: z.int().min(60).max(31_536_000).parse(ttlSeconds) };
    return cloudflareEnvelope(ArtifactsRestToken).parse(
      await this.#client.post(`${this.#namespace}/tokens`, { body }),
    ).result;
  }

  /** Revokes a token by id; false when there was none. */
  async revokeToken(id: string): Promise<boolean> {
    try {
      await this.#client.delete(`${this.#namespace}/tokens/${encodeURIComponent(id)}`);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
