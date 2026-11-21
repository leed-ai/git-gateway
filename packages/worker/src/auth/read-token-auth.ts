// SPDX-License-Identifier: Apache-2.0
import type { Authenticator, Authorizer } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { Principal, PrincipalInput } from '@leed-ai/git-gateway-contract/proxy/principal';
import { readCredential } from '@leed-ai/git-gateway-contract/proxy/request-credential';
import type { RepoName } from '@leed-ai/git-gateway-contract/schemas/names';

import { READ_TOKEN_PREFIX, ReadTokenSecret, verifyReadToken } from '../rpc/read-token.ts';

/**
 * Every principal established from a read token has a subject starting with this prefix
 * (`read-token:<jti>`). {@link withReadTokens} refuses any other authenticator's principal that
 * claims it, so the subject cannot be forged by a deployment's own credentials.
 */
export const READ_TOKEN_SUBJECT_PREFIX = 'read-token:';

/** The role a read token grants: read access to `repo` and nothing else. */
export function readTokenRole(repo: string): string {
  return `read:${repo}`;
}

/** Whether a principal was established from a read token. */
export function isReadTokenPrincipal(principal: Pick<Principal, 'subject'>): boolean {
  return principal.subject.startsWith(READ_TOKEN_SUBJECT_PREFIX);
}

/** Options of {@link ReadTokenAuthenticator}. */
export interface ReadTokenAuthenticatorOptions {
  /** The HMAC key mintReadToken() signs with (the RPC service's `readTokenSecret`). */
  readonly secret: string;
  /** The clock tokens are checked against; default the system clock. */
  readonly now?: () => Date;
}

/**
 * Accepts the read tokens mintReadToken() issues (`ggr_…`), sent as the HTTP Basic password (any
 * username) or as a Bearer token. A valid token becomes a principal with subject
 * `read-token:<jti>`, the single role `read:<repo>` and `expiresAt` the token's expiry; anything
 * else — another kind of credential, a forged, expired or malformed token — is null. It grants
 * nothing by itself: pair it with {@link readTokenAuthorizer}, or use {@link withReadTokens}, which
 * composes both with a deployment's own authenticator and authorizer.
 */
export class ReadTokenAuthenticator implements Authenticator {
  readonly #secret: string;
  readonly #now: () => Date;

  constructor(options: ReadTokenAuthenticatorOptions) {
    this.#secret = ReadTokenSecret.parse(options.secret);
    this.#now = options.now ?? (() => new Date());
  }

  async authenticate(request: Request): Promise<PrincipalInput | null> {
    const credential = readCredential(request);
    if (credential === null || !credential.secret.startsWith(READ_TOKEN_PREFIX)) return null;
    const claims = await verifyReadToken(credential.secret, this.#secret, this.#now());
    if (claims === null) return null;
    return {
      subject: `${READ_TOKEN_SUBJECT_PREFIX}${claims.jti}`,
      name: null,
      email: null,
      roles: [readTokenRole(claims.repo)],
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
  }
}

/**
 * An authorizer for read-token principals: one may read (clone, fetch) the repository its token
 * names and nothing else — never push, never another repository. Every other principal is
 * decided by `fallback`. Use it only behind an authenticator that keeps other principals out of
 * the `read-token:` subject namespace, as {@link withReadTokens} does.
 */
export function readTokenAuthorizer(fallback: Authorizer): Authorizer {
  return {
    authorize: async (principal: Principal, repo: RepoName, operation) => {
      if (!isReadTokenPrincipal(principal)) return fallback.authorize(principal, repo, operation);
      return (
        operation === 'read' && principal.roles.length === 1 && principal.roles[0] === readTokenRole(repo)
      );
    },
  };
}

/** Options of {@link withReadTokens}. */
export interface WithReadTokensOptions extends ReadTokenAuthenticatorOptions {
  /** The deployment's own authenticator, asked about every credential that is not a read token. */
  readonly authenticator: Authenticator;
  /** The deployment's own authorizer, asked about every principal not established from a read token. */
  readonly authorizer: Authorizer;
}

/**
 * Chains read tokens in front of a deployment's own authentication: a `ggr_` credential is checked
 * by {@link ReadTokenAuthenticator} alone (an invalid one is refused, never handed on), any other
 * credential goes to `authenticator`, whose principals may not use the `read-token:` subject
 * prefix (such a principal is refused). The returned authorizer limits read-token principals to
 * reading their one repository and leaves every other decision to `authorizer`. Pass both results
 * to createGatewayApp, and the RPC service's `readTokenSecret` as `secret`, so a token from
 * mintReadToken() clones `remoteUrl`.
 */
export function withReadTokens(options: WithReadTokensOptions): {
  readonly authenticator: Authenticator;
  readonly authorizer: Authorizer;
} {
  const readTokens = new ReadTokenAuthenticator(options);
  const own = options.authenticator;
  return {
    authenticator: {
      authenticate: async (request) => {
        const credential = readCredential(request);
        if (credential?.secret.startsWith(READ_TOKEN_PREFIX) === true)
          return readTokens.authenticate(request);
        const principal = await own.authenticate(request);
        if (principal === null) return null;
        return principal.subject.startsWith(READ_TOKEN_SUBJECT_PREFIX) ? null : principal;
      },
    },
    authorizer: readTokenAuthorizer(options.authorizer),
  };
}
