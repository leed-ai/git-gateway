// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';

/** Files git tracks plus untracked files it does not ignore, relative to the repository root. */
export function trackedFiles(rootDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return output.split('\0').filter((path) => path.length > 0);
}
