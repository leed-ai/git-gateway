// SPDX-License-Identifier: Apache-2.0

/** The header every source file opens with. */
export const SPDX_HEADER = '// SPDX-License-Identifier: Apache-2.0';

/** Source files that must carry the header. */
export const SPDX_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** True when a path is a source file that needs the header. */
export function needsSpdxHeader(path: string): boolean {
  return SPDX_EXTENSIONS.some((extension) => path.endsWith(extension)) && !path.endsWith('.d.ts');
}

/** True when the file's first line (after an optional shebang) is the SPDX header. */
export function hasSpdxHeader(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.startsWith('#!') === true ? lines[1] : lines[0];
  return first?.trim() === SPDX_HEADER;
}
