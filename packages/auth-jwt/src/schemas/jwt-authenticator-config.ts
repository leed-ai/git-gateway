// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { JwtAlgorithm } from './jwt-algorithm.ts';

const claimName = (what: string, fallback: string) =>
  z
    .string()
    .min(1)
    .max(100)
    .default(fallback)
    .describe(`Name of the claim holding ${what}; default "${fallback}".`);

/** Which JWT claims become which Principal fields. */
export const JwtClaimMapping = z
  .object({
    subject: claimName('the principal subject (a non-empty string; required in every token)', 'sub'),
    name: claimName('the display name (optional; ignored unless a non-empty single-line string)', 'name'),
    email: claimName('the email address (optional; ignored unless a valid address)', 'email'),
    roles: claimName(
      'the roles: an array of strings, or one string of space- or comma-separated names (optional; names with whitespace are dropped)',
      'roles',
    ),
  })
  .strict()
  .meta({
    id: 'JwtClaimMapping',
    title: 'JWT claim mapping',
    description: 'Which claims of a verified JWT fill which Principal fields.',
    examples: [{ subject: 'sub', name: 'name', email: 'email', roles: 'roles' }],
  });

/** A claim mapping as written (defaults optional). */
export type JwtClaimMappingInput = z.input<typeof JwtClaimMapping>;

/** Configuration of the JWT (JWKS/OIDC) authenticator. */
export const JwtAuthenticatorConfig = z
  .object({
    issuer: z
      .url({ protocol: /^https?$/ })
      .describe(
        'The required "iss" claim, compared exactly; also the base of OIDC discovery when `jwksUrl` is null.',
      ),
    audience: z
      .array(z.string().min(1).max(255).describe('One accepted audience value.'))
      .min(1)
      .max(20)
      .describe(
        'Accepted "aud" values: a token is accepted when its audience (a string or an array) contains any of them.',
      ),
    jwksUrl: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .default(null)
      .describe(
        'Where the signing keys (a JWK Set) are fetched; null (the default) discovers them from <issuer>/.well-known/openid-configuration ("jwks_uri").',
      ),
    algorithms: z
      .array(JwtAlgorithm)
      .min(1)
      .max(10)
      .default(['RS256', 'ES256'])
      .describe(
        'Signature algorithms accepted; a token signed otherwise is refused. Default ["RS256", "ES256"].',
      ),
    clockToleranceSeconds: z
      .int()
      .min(0)
      .max(300)
      .default(60)
      .describe(
        'Seconds of clock skew allowed when checking "exp" and "nbf"; the principal expires this long after "exp" too. 0–300, default 60.',
      ),
    jwksCacheSeconds: z
      .int()
      .min(10)
      .max(86_400)
      .default(600)
      .describe(
        'Seconds fetched keys are reused before being fetched again; a token naming an unknown "kid" refetches sooner. The issuer is asked at most every 10 seconds, and when a refetch fails the last keys fetched keep being used. 10–86400, default 600.',
      ),
    claims: JwtClaimMapping.default({
      subject: 'sub',
      name: 'name',
      email: 'email',
      roles: 'roles',
    }).describe('Which claims fill which Principal fields; defaults to sub, name, email and roles.'),
  })
  .strict()
  .meta({
    id: 'JwtAuthenticatorConfig',
    title: 'JWT authenticator configuration',
    description:
      'Configuration of the reference JWT authenticator: tokens (as a Bearer header or the HTTP Basic password git sends) are verified against the issuer\'s JWKS, and must carry the issuer, an accepted audience and an unexpired "exp".',
    examples: [
      {
        issuer: 'https://auth.example.com',
        audience: ['git.example.com'],
        jwksUrl: null,
        algorithms: ['RS256', 'ES256'],
        clockToleranceSeconds: 60,
        jwksCacheSeconds: 600,
        claims: { subject: 'sub', name: 'name', email: 'email', roles: 'roles' },
      },
    ],
  });

/** A JWT authenticator configuration as written (defaults optional). */
export type JwtAuthenticatorConfigInput = z.input<typeof JwtAuthenticatorConfig>;
/** A complete JWT authenticator configuration, inferred from {@link JwtAuthenticatorConfig}. */
export type JwtAuthenticatorConfig = z.output<typeof JwtAuthenticatorConfig>;
