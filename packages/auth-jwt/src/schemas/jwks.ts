// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** One public key of a JWK Set. */
export const Jwk = z
  .looseObject({
    kty: z.enum(['RSA', 'EC', 'OKP']).meta({
      description: 'Key type.',
      enumDescriptions: {
        RSA: 'An RSA public key (n, e).',
        EC: 'An elliptic-curve public key (crv, x, y).',
        OKP: 'An Ed25519 public key (crv, x).',
      },
    }),
    kid: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Key id, matched against a token header\'s "kid"; absent on single-key sets.'),
    alg: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe('The algorithm the key is for; when present a token must use it.'),
    use: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe('Intended use; keys whose use is not "sig" are ignored. Absent means any.'),
    n: base64url.optional().describe('RSA modulus, base64url.'),
    e: base64url.optional().describe('RSA public exponent, base64url.'),
    crv: z.string().min(1).max(20).optional().describe('Curve: P-256 or P-384 for EC, Ed25519 for OKP.'),
    x: base64url.optional().describe('Curve point x coordinate (EC) or public key (OKP), base64url.'),
    y: base64url.optional().describe('Curve point y coordinate (EC), base64url.'),
  })
  .meta({
    id: 'Jwk',
    title: 'JSON Web Key',
    description:
      'One public signing key from a JWK Set (RFC 7517). Members the authenticator does not use are kept but ignored.',
    examples: [
      {
        kty: 'EC',
        kid: 'key-1',
        alg: 'ES256',
        use: 'sig',
        crv: 'P-256',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
      },
    ],
  });

/** A JSON Web Key, inferred from {@link Jwk}. */
export type Jwk = z.infer<typeof Jwk>;

/** A JWK Set document. */
export const JwkSet = z
  .looseObject({
    keys: z.array(Jwk).max(100).describe("The issuer's public keys, at most 100."),
  })
  .meta({
    id: 'JwkSet',
    title: 'JWK Set',
    description: "The document at an issuer's jwks_uri (RFC 7517 §5): its public signing keys.",
    examples: [
      { keys: [{ kty: 'RSA', kid: 'rsa-1', n: 'sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri', e: 'AQAB' }] },
    ],
  });

/** A JWK Set, inferred from {@link JwkSet}. */
export type JwkSet = z.infer<typeof JwkSet>;

/** The part of an OpenID Provider configuration the authenticator reads. */
export const OidcDiscovery = z
  .looseObject({
    issuer: z.string().min(1).describe("The provider's issuer identifier; must equal the configured issuer."),
    jwks_uri: z.url({ protocol: /^https?$/ }).describe('Where the provider publishes its JWK Set.'),
  })
  .meta({
    id: 'OidcDiscovery',
    title: 'OIDC discovery document',
    description:
      'The fields of <issuer>/.well-known/openid-configuration (OpenID Connect Discovery 1.0) the authenticator uses.',
    examples: [
      { issuer: 'https://auth.example.com', jwks_uri: 'https://auth.example.com/.well-known/jwks.json' },
    ],
  });

/** An OIDC discovery document, inferred from {@link OidcDiscovery}. */
export type OidcDiscovery = z.infer<typeof OidcDiscovery>;
