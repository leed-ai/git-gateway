// SPDX-License-Identifier: Apache-2.0
import { decodeBase64Url } from './base64url.ts';
import type { Jwk } from './schemas/jwks.ts';
import type { JwtAlgorithm } from './schemas/jwt-algorithm.ts';
import { JwtClaims, JwtHeader } from './schemas/jwt-parts.ts';

/** A JWT split into its parts, the header and claims parsed but nothing verified yet. */
export interface DecodedJwt {
  readonly header: JwtHeader;
  readonly claims: JwtClaims;
  /** The bytes the signature covers: "<header>.<payload>" as sent. */
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
}

/** A base64url JSON segment, parsed. */
const segment = (part: string): unknown => JSON.parse(new TextDecoder().decode(decodeBase64Url(part)));

/** Splits and parses a compact JWS JWT; null when it is not one. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header = '', payload = '', signature = ''] = parts;
  try {
    const parsedHeader = JwtHeader.safeParse(segment(header));
    const parsedClaims = JwtClaims.safeParse(segment(payload));
    if (!parsedHeader.success || !parsedClaims.success) return null;
    return {
      header: parsedHeader.data,
      claims: parsedClaims.data,
      signingInput: new TextEncoder().encode(`${header}.${payload}`),
      signature: decodeBase64Url(signature),
    };
  } catch {
    return null;
  }
}

/** Web Crypto parameters for importing a key and verifying with it. */
interface Algorithms {
  readonly kty: Jwk['kty'];
  readonly import: { readonly name: string; readonly hash?: string; readonly namedCurve?: string };
  readonly verify: { readonly name: string; readonly hash?: string; readonly saltLength?: number };
}

/** The public members of a key Web Crypto imports, without the ones the authenticator ignores. */
interface PublicJwk {
  kty: string;
  ext: boolean;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

function publicJwk(key: Jwk): PublicJwk {
  const jwk: PublicJwk = { kty: key.kty, ext: true };
  for (const member of ['n', 'e', 'crv', 'x', 'y'] as const) {
    const value = key[member];
    if (value !== undefined) jwk[member] = value;
  }
  return jwk;
}

const ALGORITHMS: Readonly<Record<JwtAlgorithm, Algorithms>> = {
  RS256: {
    kty: 'RSA',
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS384: {
    kty: 'RSA',
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS512: {
    kty: 'RSA',
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  PS256: {
    kty: 'RSA',
    import: { name: 'RSA-PSS', hash: 'SHA-256' },
    verify: { name: 'RSA-PSS', saltLength: 32 },
  },
  PS384: {
    kty: 'RSA',
    import: { name: 'RSA-PSS', hash: 'SHA-384' },
    verify: { name: 'RSA-PSS', saltLength: 48 },
  },
  PS512: {
    kty: 'RSA',
    import: { name: 'RSA-PSS', hash: 'SHA-512' },
    verify: { name: 'RSA-PSS', saltLength: 64 },
  },
  ES256: {
    kty: 'EC',
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    kty: 'EC',
    import: { name: 'ECDSA', namedCurve: 'P-384' },
    verify: { name: 'ECDSA', hash: 'SHA-384' },
  },
  EdDSA: { kty: 'OKP', import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
  Ed25519: { kty: 'OKP', import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
};

/** The two names of EdDSA on Ed25519: the polymorphic "EdDSA" and the fully-specified "Ed25519". */
const OKP_NAMES: ReadonlySet<string> = new Set(['EdDSA', 'Ed25519']);

/** Whether `key` may verify a token signed with `algorithm` (key type, curve and any "alg"/"use" agree). */
export function keyFits(key: Jwk, algorithm: JwtAlgorithm): boolean {
  const spec = ALGORITHMS[algorithm];
  if (key.kty !== spec.kty) return false;
  if (key.alg !== undefined && key.alg !== algorithm && !(OKP_NAMES.has(key.alg) && OKP_NAMES.has(algorithm)))
    return false;
  if (key.use !== undefined && key.use !== 'sig') return false;
  if (spec.import.namedCurve !== undefined && key.crv !== spec.import.namedCurve) return false;
  return !OKP_NAMES.has(algorithm) || key.crv === 'Ed25519';
}

/** Verifies a decoded JWT's signature with one public key; false on any mismatch or import failure. */
export async function verifySignature(jwt: DecodedJwt, algorithm: JwtAlgorithm, key: Jwk): Promise<boolean> {
  if (!keyFits(key, algorithm)) return false;
  const spec = ALGORITHMS[algorithm];
  try {
    const imported = await crypto.subtle.importKey('jwk', publicJwk(key), spec.import, false, ['verify']);
    return await crypto.subtle.verify(spec.verify, imported, jwt.signature, jwt.signingInput);
  } catch {
    return false;
  }
}
