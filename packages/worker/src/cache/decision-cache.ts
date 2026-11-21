// SPDX-License-Identifier: Apache-2.0

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

/** Options of a {@link DecisionCache}. */
export interface DecisionCacheOptions {
  /** Most entries held; the least recently used is evicted first. 0 disables the cache. */
  readonly maxEntries: number;
  /** The clock, in milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A small per-isolate cache of authentication and authorization decisions: each entry lives for
 * its own TTL, and once full the least recently used entry is evicted. Keys are built by the
 * caller from credential fingerprints and principal subjects — never from a credential itself.
 */
export class DecisionCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: DecisionCacheOptions) {
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  /** How many entries are held (expired ones included until they are next touched). */
  get size(): number {
    return this.#entries.size;
  }

  /** The live value for `key`, or undefined when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#now()) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` for `ttlMs` milliseconds; a TTL of 0 or less stores nothing. */
  set(key: string, value: V, ttlMs: number): void {
    if (this.#maxEntries === 0 || ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}
