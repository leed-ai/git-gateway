// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { DecisionCache } from '../src/cache/decision-cache.ts';

describe('DecisionCache', () => {
  it('returns a value until its TTL passes', () => {
    let now = 0;
    const cache = new DecisionCache<string>({ maxEntries: 10, now: () => now });
    cache.set('a', 'x', 1000);
    now = 999;
    expect(cache.get('a')).toBe('x');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('stores nothing for a TTL of 0 or when disabled', () => {
    const cache = new DecisionCache<string>({ maxEntries: 10 });
    cache.set('a', 'x', 0);
    cache.set('b', 'x', -5);
    expect(cache.size).toBe(0);
    const disabled = new DecisionCache<string>({ maxEntries: 0 });
    disabled.set('a', 'x', 1000);
    expect(disabled.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new DecisionCache<number>({ maxEntries: 2, now: () => 0 });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, 1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('never holds more than its limit and never returns an expired or overwritten value (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(
          fc.tuple(
            fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
            fc.integer({ min: 0, max: 100 }),
            fc.integer({ min: 0, max: 50 }),
          ),
          { maxLength: 60 },
        ),
        (max, operations) => {
          let now = 0;
          const cache = new DecisionCache<number>({ maxEntries: max, now: () => now });
          const model = new Map<string, { value: number; expiresAt: number }>();
          operations.forEach(([key, ttl, advance], value) => {
            now += advance;
            cache.set(key, value, ttl);
            if (ttl > 0) model.set(key, { value, expiresAt: now + ttl });
            expect(cache.size).toBeLessThanOrEqual(max);
            const got = cache.get(key);
            const expected = model.get(key);
            // A miss is always allowed (the entry may have been evicted); a hit must be live and current.
            const consistent = got === undefined || (got === expected?.value && expected.expiresAt > now);
            expect(consistent).toBe(true);
          });
        },
      ),
    );
  });
});
