// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { RepoName } from '@leed-ai/git-gateway-contract/schemas/names';
import { bytesToHex } from '@leed-ai/git-gateway-core/bytes';
import { z } from 'zod';

/** Every read token starts with this prefix, so secret scanners and the proxy can recognise one. */
export const READ_TOKEN_PREFIX = 'ggr_';

/** The secret read tokens are signed with. */
export const ReadTokenSecret = z
  .string()
  .min(32)
  .max(4096)
  .meta({
    id: 'ReadTokenSecret',
    title: 'Read-token secret',
    description:
      'The HMAC-SHA256 key that signs and verifies read tokens: 32–4096 characters of high-entropy secret, set as a Worker secret. Rotating it invalidates every token issued.',
    examples: ['0123456789abcdef0123456789abcdef'],
  });

/** What a read token asserts. */
export const ReadTokenClaims = z
  .object({
    v: z.literal(1).describe('Token format version; always 1.'),
    repo: RepoName.describe('The one repository the token may clone and fetch.'),
    iat: z.int().min(0).describe('When the token was issued, in whole seconds since the Unix epoch.'),
    exp: z
      .int()
      .min(0)
      .describe('When the token stops working, in whole seconds since the Unix epoch; after `iat`.'),
    jti: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .describe('Random token id, 32 lowercase hex digits, so two tokens issued together differ.'),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat, { message: 'exp must be after iat', path: ['exp'] })
  .meta({
    id: 'ReadTokenClaims',
    title: 'Read-token claims',
    description:
      'What a read token from mintReadToken() asserts: read access to one repository until `exp`. Signed with HMAC-SHA256; carries no storage-host credential.',
    examples: [
      { v: 1, repo: 'acme-raw-content', iat: 1_795_000_000, exp: 1_795_003_600, jti: '0'.repeat(32) },
    ],
  });

/** Read-token claims, inferred from {@link ReadTokenClaims}. */
export type ReadTokenClaims = z.infer<typeof ReadTokenClaims>;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const key = utf8(ReadTokenSecret.parse(secret));
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Options of {@link mintReadToken}. */
export interface MintReadTokenOptions {
  readonly repo: string;
  readonly ttlSeconds: number;
  readonly secret: string;
  readonly now: Date;
}

/**
 * Issues a read token for one repository: `ggr_<claims>.<signature>`, both base64url, the claims
 * JSON signed with HMAC-SHA256 under `secret`. The token is a credential: return it to the caller
 * and nowhere else (never into a log or a Workflow step result).
 */
export async function mintReadToken(
  options: MintReadTokenOptions,
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(options.now.getTime() / 1000);
  const claims = ReadTokenClaims.parse({
    v: 1,
    repo: options.repo,
    iat,
    exp: iat + options.ttlSeconds,
    jti: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  });
  const payload = base64Url(utf8(JSON.stringify(claims)));
  const key = await hmacKey(options.secret, 'sign');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(payload)));
  return {
    token: `${READ_TOKEN_PREFIX}${payload}.${base64Url(signature)}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Checks a read token: its signature under `secret` (compared in constant time by WebCrypto),
 * its claims and its expiry against `now`. Returns the claims of a valid token and null for
 * anything else — malformed, forged, signed with another secret or expired. An authenticator
 * grants read access to `claims.repo` and nothing more.
 */
export async function verifyReadToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<ReadTokenClaims | null> {
  if (!token.startsWith(READ_TOKEN_PREFIX) || token.length > 4096) return null;
  const [payload, signature, ...rest] = token.slice(READ_TOKEN_PREFIX.length).split('.');
  if (payload === undefined || signature === undefined || rest.length > 0) return null;
  const signatureBytes = fromBase64Url(signature);
  const payloadBytes = fromBase64Url(payload);
  if (signatureBytes === null || payloadBytes === null) return null;
  const key = await hmacKey(secret, 'verify');
  if (!(await crypto.subtle.verify('HMAC', key, signatureBytes, utf8(payload)))) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  const claims = ReadTokenClaims.safeParse(decoded);
  if (!claims.success) return null;
  return claims.data.exp * 1000 > now.getTime() ? claims.data : null;
}
