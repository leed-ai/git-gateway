// SPDX-License-Identifier: Apache-2.0

/** The credential a request carries. */
export interface RequestCredential {
  /** How it was sent. */
  readonly scheme: 'basic' | 'bearer';
  /** The HTTP Basic user name (git's credential "username"); null for a Bearer token. */
  readonly username: string | null;
  /** The bearer credential: the Bearer token, or the HTTP Basic password. Secret. */
  readonly secret: string;
}

/**
 * The credential in a request's Authorization header. git sends credentials as HTTP Basic, and
 * the password is treated as a bearer credential (an OAuth access token, a JWT, an API key), so a
 * credential helper can supply one; a Bearer header is accepted too. Null when there is none, or
 * the header is malformed or carries an empty secret.
 */
export function readCredential(request: Request): RequestCredential | null {
  const header = request.headers.get('Authorization')?.trim();
  if (header === undefined) return null;
  const space = header.indexOf(' ');
  if (space === -1) return null;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === 'bearer') return value === '' ? null : { scheme, username: null, secret: value };
  if (scheme !== 'basic') return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.codePointAt(0) ?? 0));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  const secret = decoded.slice(colon + 1);
  return secret === '' ? null : { scheme, username: decoded.slice(0, colon), secret };
}

/**
 * A SHA-256 fingerprint of a credential (lowercase hex), so caches can key on it without holding
 * the credential.
 */
export async function credentialFingerprint(credential: RequestCredential): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential.secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
