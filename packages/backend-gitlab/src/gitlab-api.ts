// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import type { z } from 'zod';

import { GitLabErrorBody } from './schemas/gitlab-responses.ts';

/** A GitLab API call that answered with an error status. */
export class GitLabHttpError extends Error {
  override readonly name = 'GitLabHttpError';
  readonly status: number;
  /** GitLab's message, flattened to text ("404 Project Not Found", "path has already been taken"). */
  readonly detail: string;

  constructor(status: number, detail: string, what: string) {
    super(`GitLab ${what} answered ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }

  /** A 404 about the project itself, as opposed to a missing branch, commit, file or blob in it. */
  get projectMissing(): boolean {
    return this.status === 404 && /project not found/i.test(this.detail);
  }
}

function flatten(body: GitLabErrorBody): string {
  if (typeof body.message === 'string') return body.message;
  if (body.message !== undefined) {
    return Object.entries(body.message)
      .map(([field, problems]) => `${field} ${problems.join(', ')}`)
      .join('; ');
  }
  return body.error ?? 'no message';
}

/** Options of one API request. */
export interface GitLabRequest {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
}

/**
 * The GitLab REST API (v4) over `fetch`, authenticated with a PRIVATE-TOKEN header. Error
 * statuses throw {@link GitLabHttpError}; successful JSON is parsed with a Zod schema.
 */
export class GitLabApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, token: string, fetch: FetchLike) {
    this.#base = `${baseUrl.replace(/\/$/, '')}/api/v4`;
    this.#token = token;
    this.#fetch = fetch;
  }

  /** Sends a request and returns the successful response. */
  async request(path: string, options: GitLabRequest = {}): Promise<Response> {
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    const headers = new Headers({ 'PRIVATE-TOKEN': this.#token, Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.#fetch(
      new Request(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    if (response.ok) return response;
    const text = await response.text();
    let detail = text.slice(0, 200) || response.statusText;
    try {
      const parsed = GitLabErrorBody.safeParse(JSON.parse(text));
      if (parsed.success) detail = flatten(parsed.data);
    } catch {
      // Not JSON: keep the text.
    }
    throw new GitLabHttpError(
      response.status,
      detail,
      `${options.method ?? 'GET'} ${path.split('?')[0] ?? path}`,
    );
  }

  /** Sends a request and parses the JSON body with `schema`. */
  async json<S extends z.ZodType>(
    schema: S,
    path: string,
    options: GitLabRequest = {},
  ): Promise<z.output<S>> {
    const response = await this.request(path, options);
    return schema.parse(await response.json());
  }

  /** Sends a GET and returns the body bytes, or null on a 404 that is not about the project. */
  async bytesOrNull(path: string, query: GitLabRequest['query'] = {}): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await this.request(path, { query })).arrayBuffer());
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404 && !error.projectMissing) return null;
      throw error;
    }
  }
}
