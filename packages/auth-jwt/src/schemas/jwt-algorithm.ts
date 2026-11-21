// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** A JWS signature algorithm the authenticator can verify with Web Crypto. */
export const JwtAlgorithm = z
  .enum(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'EdDSA', 'Ed25519'])
  .meta({
    id: 'JwtAlgorithm',
    title: 'JWT algorithm',
    description:
      'A JWS "alg" the JWT authenticator verifies with Web Crypto. Symmetric algorithms (HS*) and "none" are never accepted.',
    enumDescriptions: {
      RS256: 'RSASSA-PKCS1-v1_5 with SHA-256 (RSA key).',
      RS384: 'RSASSA-PKCS1-v1_5 with SHA-384 (RSA key).',
      RS512: 'RSASSA-PKCS1-v1_5 with SHA-512 (RSA key).',
      PS256: 'RSASSA-PSS with SHA-256 (RSA key).',
      PS384: 'RSASSA-PSS with SHA-384 (RSA key).',
      PS512: 'RSASSA-PSS with SHA-512 (RSA key).',
      ES256: 'ECDSA on P-256 with SHA-256 (EC key).',
      ES384: 'ECDSA on P-384 with SHA-384 (EC key).',
      EdDSA: 'EdDSA with an Ed25519 key (OKP key, crv Ed25519).',
      Ed25519: 'Ed25519, the fully-specified name of EdDSA on Ed25519 (RFC 9864); same keys as EdDSA.',
    },
    examples: ['RS256', 'ES256'],
  });

/** A JWS algorithm, inferred from {@link JwtAlgorithm}. */
export type JwtAlgorithm = z.infer<typeof JwtAlgorithm>;
