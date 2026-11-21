// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { coreError } from '../core-error.ts';
import { readPack, type BaseLookup } from '../pack/read-pack.ts';
import { writePack } from '../pack/write-pack.ts';
import { encodeReceivePackRequest } from '../receive-pack/encode-request.ts';
import { parseReportStatus, reportStatusFraming } from '../receive-pack/report-status.ts';
import type { GitObject } from '../schemas/git-object.ts';
import type { ReceivePackCommand } from '../schemas/receive-pack.ts';
import type { GitService, RefAdvertisement } from '../schemas/ref-advertisement.ts';
import type { ReportStatus } from '../schemas/report-status.ts';
import type { UploadPackRequestInput, UploadPackResponse } from '../schemas/upload-pack.ts';
import { encodeUploadPackRequest } from '../upload-pack/encode-request.ts';
import { parseUploadPackResponse } from '../upload-pack/parse-response.ts';
import { parseRefAdvertisement } from './ref-advertisement.ts';

/** Sends one HTTP request: `fetch`, or a stand-in such as an in-memory server's handler. */
export type FetchLike = (request: Request) => Promise<Response>;

/** A smart-HTTP remote: the repository URL (ending in ".git") and the headers that authorize it. */
export interface GitHttpRemote {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Options of a {@link GitHttpClient}. */
export interface GitHttpClientOptions {
  /** How requests are sent; default the global `fetch`. */
  readonly fetch?: FetchLike;
  /** The User-Agent sent; default "git/2.43.0 (git-gateway)", since some hosts gate on a git agent. */
  readonly userAgent?: string;
}

/** A fetched pack: the parsed response and its objects, deltas resolved. */
export interface FetchedPack {
  readonly response: UploadPackResponse;
  readonly objects: GitObject[];
}

/** What a push asks for beyond its commands. */
export interface PushOptions {
  /** Ask the server to apply all commands or none ("atomic"); ignored when not advertised. */
  readonly atomic?: boolean;
}

const DEFAULT_AGENT = 'git/2.43.0 (git-gateway)';
const CONTENT_TYPES: Readonly<Record<GitService, string>> = {
  'git-upload-pack': 'application/x-git-upload-pack-request',
  'git-receive-pack': 'application/x-git-receive-pack-request',
};

/**
 * A minimal git smart-HTTP client (protocol v0/v1) built on the core codecs: read a ref
 * advertisement, push a pack with update commands, fetch a pack. It needs nothing but `fetch`, so
 * it runs in Workers, Bun and Node. Used by backends that read through the git transport and by
 * the backend contract suite. A non-2xx HTTP status throws a remote_http_error CoreError carrying the status; an in-protocol
 * refusal (an "ERR" packet, side-band channel 3) throws remote_error.
 */
export class GitHttpClient {
  readonly #remote: GitHttpRemote;
  readonly #fetch: FetchLike;
  readonly #agent: string;

  constructor(remote: GitHttpRemote, options: GitHttpClientOptions = {}) {
    this.#remote = remote;
    this.#fetch = options.fetch ?? (async (request) => fetch(request));
    this.#agent = options.userAgent ?? DEFAULT_AGENT;
  }

  /** The ref advertisement of a service (GET info/refs?service=…). */
  async advertisement(service: GitService): Promise<RefAdvertisement> {
    const response = await this.#send(
      new Request(`${this.#remote.url}/info/refs?service=${service}`, {
        headers: this.#headers({}),
      }),
    );
    return parseRefAdvertisement(new Uint8Array(await response.arrayBuffer()), service);
  }

  /**
   * Pushes `objects` (as one pack) with update commands, and returns the server's report. Sends no
   * pack when every command is a delete. Requests report-status, plus side-band-64k and atomic
   * when the server advertises them.
   */
  async push(
    commands: readonly ReceivePackCommand[],
    objects: readonly GitObject[],
    options: PushOptions = {},
  ): Promise<ReportStatus> {
    const advertised = (await this.advertisement('git-receive-pack')).capabilities;
    const wanted = ['report-status', 'side-band-64k', ...(options.atomic === true ? ['atomic'] : [])];
    const capabilities = wanted.filter((capability) => advertised.includes(capability));
    const deletesOnly = commands.every((command) => command.newSha === ZERO_SHA);
    const body = encodeReceivePackRequest({
      commands: [...commands],
      capabilities,
      ...(deletesOnly ? {} : { pack: await writePack(objects) }),
    });
    const response = await this.#post('git-receive-pack', body);
    return parseReportStatus(new Uint8Array(await response.arrayBuffer()), reportStatusFraming(capabilities));
  }

  /** Fetches a pack for `request` and reads its objects; `lookupBase` resolves thin-pack bases. */
  async fetchPack(request: UploadPackRequestInput, lookupBase?: BaseLookup): Promise<FetchedPack> {
    const body = encodeUploadPackRequest(request);
    const response = await this.#post('git-upload-pack', body);
    const capabilities = request.capabilities ?? ['side-band-64k'];
    const parsed = parseUploadPackResponse(new Uint8Array(await response.arrayBuffer()), {
      deepen: request.depth !== undefined,
      sideBand: capabilities.includes('side-band-64k') || capabilities.includes('side-band'),
    });
    const objects =
      parsed.pack.length === 0
        ? []
        : await readPack(parsed.pack, lookupBase === undefined ? {} : { lookupBase });
    return { response: parsed, objects };
  }

  async #post(service: GitService, body: Uint8Array): Promise<Response> {
    return this.#send(
      new Request(`${this.#remote.url}/${service}`, {
        method: 'POST',
        headers: this.#headers({
          'Content-Type': CONTENT_TYPES[service],
          Accept: `application/x-${service}-result`,
        }),
        body,
      }),
    );
  }

  #headers(extra: Record<string, string>): Headers {
    return new Headers({ 'User-Agent': this.#agent, ...this.#remote.headers, ...extra });
  }

  async #send(request: Request): Promise<Response> {
    const response = await this.#fetch(request);
    if (!response.ok) {
      await response.body?.cancel();
      const path = new URL(request.url).pathname;
      throw coreError('remote_http_error', `Remote HTTP error: HTTP ${response.status} from ${path}`, {
        status: response.status,
        path,
      });
    }
    return response;
  }
}
