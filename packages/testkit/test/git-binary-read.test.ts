// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import { GitVersion, parseGitVersion, readGitVersion } from '../src/git-binary.ts';

const work = mkdtempSync(join(tmpdir(), 'testkit-git-binary-'));

/** An executable stand-in for git that prints the given text for `--version`. */
const fakeGit = (name: string, output: string): string => {
  const path = join(work, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(path, 0o755);
  return path;
};

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('readGitVersion', () => {
  it.skipIf(process.platform === 'win32')(
    'runs the given binary with --version and parses its output',
    () => {
      expect(readGitVersion(fakeGit('git-2.40.1', 'git version 2.40.1'))).toEqual({
        major: 2,
        minor: 40,
        patch: 1,
        raw: '2.40.1',
      });
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a binary that is not git', () => {
    expect(() => readGitVersion(fakeGit('not-git', 'hub version 2.14.2'))).toThrow(
      /not a git --version line/,
    );
  });

  it('fails when the binary does not exist', () => {
    expect(() => readGitVersion(join(work, 'missing-git'))).toThrow(/ENOENT/);
  });
});

describe('parseGitVersion edge cases', () => {
  it('rejects text before the version line', () => {
    expect(() => parseGitVersion('warning: something\ngit version 2.43.0')).toThrow(
      /not a git --version line/,
    );
  });

  it('rejects a version missing its minor part', () => {
    expect(() => parseGitVersion('git version 2')).toThrow(/not a git --version line/);
  });

  it('keeps release-candidate suffixes in raw and reads the numbers before them', () => {
    expect(parseGitVersion('git version 2.48.0-rc1')).toEqual({
      major: 2,
      minor: 48,
      patch: 0,
      raw: '2.48.0-rc1',
    });
  });

  it('produces a value the GitVersion schema accepts', () => {
    expect(GitVersion.safeParse(parseGitVersion('git version 2.39.5 (Apple Git-154)')).success).toBe(true);
  });

  it('refuses extra fields through the strict GitVersion schema', () => {
    expect(GitVersion.safeParse({ major: 2, minor: 1, patch: 0, raw: '2.1.0', extra: true }).success).toBe(
      false,
    );
    expect(GitVersion.safeParse({ major: -1, minor: 1, patch: 0, raw: '-1.1.0' }).success).toBe(false);
    expect(GitVersion.safeParse({ major: 2, minor: 1, patch: 0, raw: '' }).success).toBe(false);
  });
});
