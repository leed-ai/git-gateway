// SPDX-License-Identifier: Apache-2.0

/** A source of the current time. */
export type Clock = () => Date;

/**
 * A deterministic clock for tests: the first call returns `start`, each later call `stepMs`
 * milliseconds after the one before. With it, the reference implementation's ids are the same on
 * every run.
 */
export function steppingClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let next = Date.parse(start);
  if (Number.isNaN(next)) throw new RangeError(`steppingClock: invalid start time ${start}`);
  return () => {
    const now = new Date(next);
    next += stepMs;
    return now;
  };
}
