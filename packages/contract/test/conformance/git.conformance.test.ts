// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { blobSha } from '../../src/reference/hash.ts';
import { BranchName, FullRefName } from '../../src/schemas/names.ts';

const GIT = process.env['GIT_BINARY'] ?? 'git';

function git(args: string[], input?: Uint8Array): { status: number | null; stdout: string } {
  const result = spawnSync(GIT, args, { input, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout.trim() };
}

const gitAcceptsBranch = (name: string): boolean => git(['check-ref-format', '--branch', name]).status === 0;
const gitAcceptsRef = (ref: string): boolean => git(['check-ref-format', ref]).status === 0;

/** Names built from the characters and fragments git's ref rules care about. */
const refLike = fc
  .array(
    fc.constantFrom(
      'a',
      'b',
      'Z',
      '0',
      '-',
      '.',
      '/',
      '@',
      '{',
      '~',
      '^',
      ':',
      '?',
      '*',
      '[',
      '\\',
      ' ',
      'é',
      '.lock',
      '..',
      '//',
      '@{',
    ),
    {
      minLength: 1,
      maxLength: 8,
    },
  )
  .map((parts) => parts.join(''));

describe(`ref names against ${GIT} check-ref-format`, () => {
  it('never accepts a branch name git rejects', () => {
    fc.assert(
      fc.property(refLike, (name) => {
        expect(!BranchName.safeParse(name).success || gitAcceptsBranch(name)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('never accepts a full ref git rejects', () => {
    fc.assert(
      fc.property(fc.constantFrom('refs/heads/', 'refs/tags/'), refLike, (prefix, name) => {
        const ref = `${prefix}${name}`;
        expect(!FullRefName.safeParse(ref).success || gitAcceptsRef(ref)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it.each(['main', 'staging', 'feature/new-page', 'release-1.2', 'a/-b', 'ü/ß'])(
    'agrees with git on %s',
    (name) => {
      expect(BranchName.safeParse(name).success).toBe(true);
      expect(gitAcceptsBranch(name)).toBe(true);
    },
  );
});

describe(`blob ids against ${GIT} hash-object`, () => {
  it('match git for arbitrary bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        expect(await blobSha(bytes)).toBe(git(['hash-object', '--stdin'], bytes).stdout);
      }),
      { numRuns: 50 },
    );
  });

  it('match git for the empty blob', async () => {
    expect(await blobSha(new Uint8Array())).toBe(git(['hash-object', '--stdin'], new Uint8Array()).stdout);
  });
});
