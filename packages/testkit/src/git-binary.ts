// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';

import { z } from 'zod';

/** The version of a git binary, parsed from `git --version`. */
export const GitVersion = z
  .object({
    major: z.number().int().nonnegative().describe('Major version number, e.g. 2 for git 2.43.0.'),
    minor: z.number().int().nonnegative().describe('Minor version number, e.g. 43 for git 2.43.0.'),
    patch: z
      .number()
      .int()
      .nonnegative()
      .describe('Patch version number, e.g. 0 for git 2.43.0; 0 when the binary reports only two parts.'),
    raw: z
      .string()
      .min(1)
      .describe(
        'The version text exactly as git printed it after "git version", e.g. "2.39.5 (Apple Git-154)".',
      ),
  })
  .strict()
  .meta({
    id: 'GitVersion',
    title: 'Git version',
    description: 'The version of the git binary a conformance run drives, parsed from `git --version`.',
    examples: [{ major: 2, minor: 43, patch: 0, raw: '2.43.0' }],
  });

/** The version of a git binary, inferred from {@link GitVersion}. */
export type GitVersion = z.infer<typeof GitVersion>;

// Only the leading numbers are matched; the rest of the line is kept verbatim in `raw`. (A pattern
// that also matched the suffix, as `\S*(?:\s.*)?$`, backtracks in polynomial time.)
const VERSION_PREFIX = 'git version ';
const VERSION_NUMBERS = /^(\d+)\.(\d+)(?:\.(\d+))?(?![\d.]*\d)/;

/** Parses the output of `git --version`; throws on anything else. */
export function parseGitVersion(output: string): GitVersion {
  const line = output.trim();
  const raw = line.startsWith(VERSION_PREFIX) ? line.slice(VERSION_PREFIX.length) : '';
  const match = line.includes('\n') ? null : VERSION_NUMBERS.exec(raw);
  if (match === null) throw new Error(`not a git --version line: ${JSON.stringify(output)}`);
  const [, major, minor, patch] = match;
  return GitVersion.parse({ major: Number(major), minor: Number(minor), patch: Number(patch ?? 0), raw });
}

/** The git binary to drive: `GIT_BINARY` from the environment when set, otherwise `git` on the PATH. */
export function gitBinary(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env['GIT_BINARY']?.trim();
  return configured === undefined || configured === '' ? 'git' : configured;
}

/** Runs `<binary> --version` and parses the result. */
export function readGitVersion(binary: string = gitBinary()): GitVersion {
  return parseGitVersion(execFileSync(binary, ['--version'], { encoding: 'utf8' }));
}

/** True when `version` is at least `major.minor.patch`. */
export function isAtLeast(version: GitVersion, major: number, minor: number, patch = 0): boolean {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}
