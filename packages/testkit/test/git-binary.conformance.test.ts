// SPDX-License-Identifier: Apache-2.0
// Runs against the real git binary (GIT_BINARY, or git on the PATH). CI runs it once per git version.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import { gitBinary, isAtLeast, readGitVersion } from '../src/git-binary.ts';

const git = gitBinary();
const expectedVersion = process.env['GIT_EXPECTED_VERSION'] ?? '';
const work = mkdtempSync(join(tmpdir(), 'git-gateway-conformance-'));
const run = (args: string[], input?: string): string =>
  execFileSync(git, args, {
    cwd: work,
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work },
  }).trim();

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe(`real git (${git})`, () => {
  it('is a supported git version', () => {
    expect(isAtLeast(readGitVersion(git), 2, 34)).toBe(true);
  });

  it.skipIf(expectedVersion === '')('is the version the CI matrix asked for', () => {
    expect(readGitVersion(git).raw.split(' ')[0]).toBe(expectedVersion);
  });

  it('hashes a blob the way the object encoder will have to', () => {
    run(['init', '--quiet', '.']);
    expect(run(['hash-object', '--stdin'], 'hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
