// SPDX-License-Identifier: Apache-2.0
import { webcrypto } from 'node:crypto';

import { encodeBase64Url } from '../../src/base64url.ts';
import type { JwtAlgorithm } from '../../src/schemas/jwt-algorithm.ts';

type GenerateParams = webcrypto.RsaHashedKeyGenParams | webcrypto.EcKeyGenParams | webcrypto.Algorithm;
type SignParams = webcrypto.RsaPssParams | webcrypto.EcdsaParams | webcrypto.Algorithm;

function rsa(name: string, hash: string): webcrypto.RsaHashedKeyGenParams {
  return { name, hash, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
}

const GENERATE: Record<JwtAlgorithm, { generate: GenerateParams; sign: SignParams }> = {
  RS256: { generate: rsa('RSASSA-PKCS1-v1_5', 'SHA-256'), sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { generate: rsa('RSASSA-PKCS1-v1_5', 'SHA-384'), sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { generate: rsa('RSASSA-PKCS1-v1_5', 'SHA-512'), sign: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { generate: rsa('RSA-PSS', 'SHA-256'), sign: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { generate: rsa('RSA-PSS', 'SHA-384'), sign: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { generate: rsa('RSA-PSS', 'SHA-512'), sign: { name: 'RSA-PSS', saltLength: 64 } },
  ES256: { generate: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  ES384: { generate: { name: 'ECDSA', namedCurve: 'P-384' }, sign: { name: 'ECDSA', hash: 'SHA-384' } },
  EdDSA: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
  Ed25519: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

/** A signing key and its public JWK. */
export interface TestKey {
  readonly algorithm: JwtAlgorithm;
  readonly kid: string;
  readonly privateKey: webcrypto.CryptoKey;
  readonly jwk: Record<string, unknown>;
}

/** Generates a key pair for `algorithm`, its public half as a JWK with `kid`. */
export async function generateTestKey(algorithm: JwtAlgorithm, kid: string): Promise<TestKey> {
  const pair = await webcrypto.subtle.generateKey(GENERATE[algorithm].generate, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error(`${algorithm} did not generate a key pair`);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const { key_ops: _ops, ext: _ext, ...jwk } = exported;
  return { algorithm, kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, use: 'sig' } };
}

const segment = (value: unknown): string => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** Signs a JWT with `key`; the header names its kid unless `header` overrides. */
export async function signToken(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const input = `${segment({ alg: key.algorithm, typ: 'JWT', kid: key.kid, ...header })}.${segment(claims)}`;
  const signature = await webcrypto.subtle.sign(
    GENERATE[key.algorithm].sign,
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** A fetch stand-in serving an issuer's discovery document and JWK Set, counting requests. */
export function issuerFetch(issuer: string, keys: () => readonly TestKey[]) {
  const calls: string[] = [];
  const fetcher = async (request: Request): Promise<Response> => {
    calls.push(request.url);
    if (request.url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks.json` });
    }
    if (request.url === `${issuer}/jwks.json`) return Response.json({ keys: keys().map((key) => key.jwk) });
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetcher, calls };
}

/** A request carrying `token` as git sends it: the password of HTTP Basic credentials. */
export function basicRequest(token: string, username = 'x-access-token'): Request {
  return new Request('https://git.example.com/repo.git/info/refs?service=git-upload-pack', {
    headers: { Authorization: `Basic ${btoa(`${username}:${token}`)}` },
  });
}
