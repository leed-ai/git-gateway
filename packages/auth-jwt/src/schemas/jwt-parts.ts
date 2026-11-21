// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** The protected header of a JWS-signed JWT. */
export const JwtHeader = z
  .looseObject({
    alg: z.string().min(1).max(20).describe('Signature algorithm; must be one the authenticator accepts.'),
    kid: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Id of the signing key in the issuer's JWK Set; absent when the set has one key."),
    typ: z.string().max(50).optional().describe('Media type, usually "JWT"; not checked.'),
  })
  .meta({
    id: 'JwtHeader',
    title: 'JWT header',
    description: 'The protected header of a signed JWT (RFC 7515 §4). Other members are allowed and ignored.',
    examples: [{ alg: 'RS256', kid: 'rsa-1', typ: 'JWT' }],
  });

/** A JWT header, inferred from {@link JwtHeader}. */
export type JwtHeader = z.infer<typeof JwtHeader>;

const numericDate = (what: string) =>
  z.number().finite().nonnegative().describe(`${what}, as seconds since the epoch (a JSON number).`);

/** The registered claims of a JWT the authenticator checks; all other claims pass through. */
export const JwtClaims = z
  .looseObject({
    iss: z.string().min(1).describe('Issuer; must equal the configured issuer.'),
    aud: z
      .union([
        z.string().min(1).describe('A single audience.'),
        z.array(z.string().min(1).describe('One audience.')).min(1).describe('Several audiences.'),
      ])
      .describe('Audience; must contain one of the configured audiences.'),
    exp: numericDate('Expiry; required, and must be in the future (with clock tolerance)'),
    nbf: numericDate('Not before; when present, must not be in the future (with clock tolerance)').optional(),
    iat: numericDate('Issued at; informational').optional(),
  })
  .meta({
    id: 'JwtClaims',
    title: 'JWT claims',
    description:
      'The payload of a JWT: the registered claims the authenticator checks (iss, aud, exp, nbf), plus any others, from which the principal is mapped.',
    examples: [
      {
        iss: 'https://auth.example.com',
        aud: 'git.example.com',
        exp: 1_795_000_000,
        sub: 'user:42',
        roles: ['maintainer'],
      },
    ],
  });

/** JWT claims, inferred from {@link JwtClaims}. */
export type JwtClaims = z.infer<typeof JwtClaims>;
