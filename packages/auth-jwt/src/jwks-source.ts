// SPDX-License-Identifier: Apache-2.0
import { JwkSet, OidcDiscovery, type Jwk } from './schemas/jwks.ts';

/** Fetches over HTTP; the global `fetch` by default. */
export type JwksFetch = (request: Request) => Promise<Response>;

/** Options of a {@link JwksSource}. */
export interface JwksSourceOptions {
  readonly issuer: string;
  /** The JWK Set URL, or null to discover it from the issuer's OpenID configuration. */
  readonly jwksUrl: string | null;
  /** Seconds keys are reused. */
  readonly cacheSeconds: number;
  readonly fetch: JwksFetch;
  /** The clock in milliseconds since the epoch. */
  readonly now: () => number;
}

/**
 * The issuer is asked at most this often (an unknown key id, or a retry after a failed fetch), so
 * bad tokens or an issuer outage cannot hammer it.
 */
const MIN_REFRESH_MS = 10_000;

async function getJson(fetcher: JwksFetch, url: string): Promise<unknown> {
  const response = await fetcher(new Request(url, { headers: { Accept: 'application/json' } }));
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

/**
 * The issuer's signing keys, fetched (through OIDC discovery when no JWKS URL is configured) and
 * cached for `cacheSeconds`. A key id not in the cached set triggers one early refetch, so key
 * rotation is picked up without waiting for the cache to expire. Every fetch attempt, failed or
 * not, starts a {@link MIN_REFRESH_MS} window in which the issuer is not asked again. When a
 * refresh fails the last keys fetched are served (stale on error), so an issuer outage does not
 * stop authentication; only with no keys ever fetched does the failure surface. Concurrent
 * callers share one fetch.
 */
export class JwksSource {
  readonly #options: JwksSourceOptions;
  #keys: readonly Jwk[] | null = null;
  /** When the keys were last fetched successfully. */
  #fetchedAt = Number.NEGATIVE_INFINITY;
  /** When the issuer was last asked, whatever the outcome. */
  #attemptedAt = Number.NEGATIVE_INFINITY;
  /** Why the last attempt failed, while no keys have ever been fetched. */
  #lastError: unknown = null;
  #pending: Promise<readonly Jwk[]> | null = null;
  /** The JWK Set URL once known (configured, or discovered once). */
  #jwksUrl: string | null;

  constructor(options: JwksSourceOptions) {
    this.#options = options;
    this.#jwksUrl = options.jwksUrl;
  }

  /** The keys that may have signed a token naming `kid` (every key when the token names none). */
  async keysFor(kid: string | undefined): Promise<readonly Jwk[]> {
    const fresh = this.#options.now() - this.#fetchedAt < this.#options.cacheSeconds * 1000;
    let keys = this.#keys !== null && fresh ? this.#keys : await this.#refresh();
    const matching = (set: readonly Jwk[]): readonly Jwk[] =>
      kid === undefined ? set : set.filter((key) => key.kid === kid);
    if (matching(keys).length === 0 && kid !== undefined) keys = await this.#refresh();
    return matching(keys);
  }

  /**
   * Fetches the keys unless the issuer was asked less than {@link MIN_REFRESH_MS} ago; serves the
   * cached keys when it was, or when the fetch fails.
   */
  async #refresh(): Promise<readonly Jwk[]> {
    if (this.#pending !== null) return this.#pending;
    if (this.#options.now() - this.#attemptedAt < MIN_REFRESH_MS) {
      if (this.#keys !== null) return this.#keys;
      throw this.#lastError ?? new Error('the issuer keys are not available yet');
    }
    this.#attemptedAt = this.#options.now();
    this.#pending = this.#load()
      .catch((error: unknown) => {
        if (this.#keys !== null) return this.#keys;
        this.#lastError = error;
        throw error;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }

  async #load(): Promise<readonly Jwk[]> {
    const { issuer, fetch: fetcher } = this.#options;
    let url = this.#jwksUrl;
    if (url === null) {
      const discovery = OidcDiscovery.parse(
        await getJson(fetcher, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`),
      );
      if (discovery.issuer !== issuer)
        throw new Error(`the discovery document names issuer ${discovery.issuer}`);
      url = discovery.jwks_uri;
      this.#jwksUrl = url;
    }
    const set = JwkSet.parse(await getJson(fetcher, url));
    this.#keys = set.keys;
    this.#fetchedAt = this.#options.now();
    this.#lastError = null;
    return set.keys;
  }
}
