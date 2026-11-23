// SPDX-License-Identifier: Apache-2.0
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';

import type { UpstreamFetch } from '../../src/proxy/upstream.ts';

/** Backend calls that read a repository. */
const READS = new Set([
  'repoInfo',
  'resolveRef',
  'readCommit',
  'readTree',
  'readBlob',
  'readFile',
  'log',
  'isAncestor',
]);

/** The repository a storage host receive-pack URL addresses, or null for any other request. */
function receivePackRepo(url: string): string | null {
  return /\/([^/]+)\.git\/git-receive-pack$/.exec(new URL(url).pathname)?.[1] ?? null;
}

/**
 * A storage host that serialises per repository, as the Artifacts local simulator does: a
 * receive-pack request holds its repository's lock until the host has answered it, and a backend
 * read of that repository meanwhile is refused (a real host would block on the lock, so a gateway
 * that reads during its own open push would hang). Every such read is recorded in `violations`,
 * so a test sees it even when the gateway turns the error into a refusal.
 */
export class RepositoryLocks {
  readonly #open = new Map<string, number>();
  readonly violations: string[] = [];

  /** Whether a receive-pack request to `repo` is open. */
  isOpen(repo: string): boolean {
    return (this.#open.get(repo) ?? 0) > 0;
  }

  /** Wraps a storage host so each receive-pack holds its repository's lock until it is answered. */
  fetch(inner: UpstreamFetch): UpstreamFetch {
    return async (request) => {
      const repo = receivePackRepo(request.url);
      if (repo === null) return inner(request);
      this.#open.set(repo, (this.#open.get(repo) ?? 0) + 1);
      try {
        return await inner(request);
      } finally {
        this.#open.set(repo, (this.#open.get(repo) ?? 1) - 1);
      }
    };
  }

  /** Wraps a backend so a read of a repository whose receive-pack is open fails. */
  backend<T extends StorageBackend>(inner: T): T {
    return new Proxy(inner, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        // Called on the target, so a backend's private fields still resolve.
        if (typeof property !== 'string' || !READS.has(property)) return value.bind(target);
        return async (repo: string, ...rest: unknown[]) => {
          if (this.isOpen(repo)) {
            this.violations.push(`${property}(${repo})`);
            throw new Error(`${property} of ${repo} while a receive-pack to it is open: the lock is held`);
          }
          return Reflect.apply(value, target, [repo, ...rest]) as unknown;
        };
      },
    });
  }
}
