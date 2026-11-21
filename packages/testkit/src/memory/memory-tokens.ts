// SPDX-License-Identifier: Apache-2.0
import type { GitAccess } from '@leed-ai/git-gateway-contract/storage/git-remote';

/** A minted credential: which repository it opens, for what, and until when. */
export interface MemoryGrant {
  readonly repo: string;
  readonly access: GitAccess;
  /** Expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Short-lived bearer tokens for the in-memory git remotes, scoped to one repository and access level. */
export class MemoryTokens {
  readonly #grants = new Map<string, MemoryGrant>();
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  /** Mints a random token for `repo` that lasts `ttlSeconds`. */
  mint(repo: string, access: GitAccess, ttlSeconds: number): { token: string; expiresAt: Date } {
    const token = `mem_${crypto.randomUUID().replaceAll('-', '')}`;
    const expiresAt = this.#now().getTime() + ttlSeconds * 1000;
    this.#grants.set(token, { repo, access, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** The live grant a token carries, or null when it is unknown or expired. */
  check(token: string): MemoryGrant | null {
    const grant = this.#grants.get(token);
    if (grant === undefined) return null;
    if (grant.expiresAt <= this.#now().getTime()) {
      this.#grants.delete(token);
      return null;
    }
    return grant;
  }

  /** Revokes every token of a repository (when it is deleted). */
  revokeRepo(repo: string): void {
    for (const [token, grant] of this.#grants) if (grant.repo === repo) this.#grants.delete(token);
  }
}

/**
 * The credential a request carries: a Bearer token, or the password of HTTP Basic (git sends
 * credentials as Basic; the password is the token). Null when there is none.
 */
export function credentialOf(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null) return null;
  const [scheme, value] = header.split(' ', 2);
  if (value === undefined) return null;
  if (scheme?.toLowerCase() === 'bearer') return value;
  if (scheme?.toLowerCase() !== 'basic') return null;
  try {
    const decoded = atob(value);
    const colon = decoded.indexOf(':');
    return colon === -1 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}
