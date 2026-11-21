// SPDX-License-Identifier: Apache-2.0
import type { Authenticator } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import { Role, type PrincipalInput } from '@leed-ai/git-gateway-contract/proxy/principal';
import { readCredential } from '@leed-ai/git-gateway-contract/proxy/request-credential';
import { z } from 'zod';

import { JwksSource, type JwksFetch } from './jwks-source.ts';
import { decodeJwt, verifySignature, type DecodedJwt } from './jwt-verify.ts';
import { JwtAlgorithm } from './schemas/jwt-algorithm.ts';
import {
  JwtAuthenticatorConfig,
  type JwtAuthenticatorConfigInput,
} from './schemas/jwt-authenticator-config.ts';

/** Options beyond the configuration: how keys are fetched and the clock (both injectable for tests). */
export interface JwtAuthenticatorOptions {
  /** Fetches the discovery document and JWK Set; default the global `fetch`. */
  readonly fetch?: JwksFetch;
  /** The clock; default the system clock. */
  readonly now?: () => Date;
}

const SingleLine = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\n\0]+$/);
const Email = z.email().max(255);

function rolesOf(value: unknown): string[] {
  const names = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return names.filter((name): name is string => Role.safeParse(name).success).slice(0, 100);
}

/**
 * The reference {@link Authenticator}: the bearer credential (a Bearer header, or the password of
 * the HTTP Basic credentials git sends, so a credential helper can supply the token) must be a JWT
 * signed by one of the issuer's keys (JWKS, discovered through OIDC unless a URL is configured)
 * with an accepted algorithm, carry the configured issuer and an accepted audience, and be
 * within its "nbf"/"exp" window. Its claims are mapped to a principal whose `expiresAt` is the
 * token's expiry, so no cached decision outlives the token. Anything else is null — a 401.
 */
export class JwtAuthenticator implements Authenticator {
  readonly #config: JwtAuthenticatorConfig;
  readonly #keys: JwksSource;
  readonly #now: () => Date;

  constructor(config: JwtAuthenticatorConfigInput, options: JwtAuthenticatorOptions = {}) {
    this.#config = JwtAuthenticatorConfig.parse(config);
    this.#now = options.now ?? (() => new Date());
    this.#keys = new JwksSource({
      issuer: this.#config.issuer,
      jwksUrl: this.#config.jwksUrl,
      cacheSeconds: this.#config.jwksCacheSeconds,
      fetch: options.fetch ?? (async (request) => fetch(request)),
      now: () => this.#now().getTime(),
    });
  }

  async authenticate(request: Request): Promise<PrincipalInput | null> {
    const credential = readCredential(request);
    const jwt = credential === null ? null : decodeJwt(credential.secret);
    if (jwt === null || !this.#claimsValid(jwt)) return null;
    const algorithm = JwtAlgorithm.safeParse(jwt.header.alg);
    if (!algorithm.success || !this.#config.algorithms.includes(algorithm.data)) return null;
    const keys = await this.#keys.keysFor(jwt.header.kid);
    for (const key of keys) {
      if (await verifySignature(jwt, algorithm.data, key)) return this.#principal(jwt);
    }
    return null;
  }

  #claimsValid({ claims }: DecodedJwt): boolean {
    const now = this.#now().getTime() / 1000;
    const tolerance = this.#config.clockToleranceSeconds;
    if (claims.iss !== this.#config.issuer) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((audience) => this.#config.audience.includes(audience))) return false;
    if (claims.exp + tolerance <= now) return false;
    return claims.nbf === undefined || claims.nbf - tolerance <= now;
  }

  #principal({ claims }: DecodedJwt): PrincipalInput | null {
    const mapping = this.#config.claims;
    const subject = SingleLine.safeParse(claims[mapping.subject]);
    if (!subject.success) return null;
    const name = SingleLine.safeParse(claims[mapping.name]);
    const email = Email.safeParse(claims[mapping.email]);
    return {
      subject: subject.data,
      name: name.success ? name.data : null,
      email: email.success ? email.data : null,
      roles: rolesOf(claims[mapping.roles]),
      // The token is accepted until exp plus the clock tolerance, so the principal lasts as long.
      expiresAt: new Date(
        Math.min((claims.exp + this.#config.clockToleranceSeconds) * 1000, 8.64e15),
      ).toISOString(),
    };
  }
}
