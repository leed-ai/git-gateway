// SPDX-License-Identifier: Apache-2.0

const EXACT_VERSION = /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAJOR_RANGE = /^\^(\d+)$/;

/** True when a dependency spec pins one exact version (e.g. `4.6.7` or `=4.6.7`) rather than a range. */
export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec.trim());
}

/**
 * The lowest version a major range such as `^4` admits (`4.0.0`); for `^4.2.1` it is `4.2.1`.
 * Returns undefined for anything that is not a single caret range.
 */
export function lowestVersionOf(range: string): string | undefined {
  const trimmed = range.trim();
  const major = MAJOR_RANGE.exec(trimmed);
  if (major !== null) return `${major[1]}.0.0`;
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (caret === null) return undefined;
  return `${caret[1]}.${caret[2] ?? '0'}.${caret[3] ?? '0'}`;
}
