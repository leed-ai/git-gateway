// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { ExamplePushPolicy } from '../src/example-push-policy.ts';

const OLD = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const NEW = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const policy = new ExamplePushPolicy({
  maxFileBytes: 100,
  protectedPrefixes: ['.github/workflows/'],
  maintainerRole: 'maintainer',
});

const input = (roles: string[], path: string, size: number) => ({
  principal: { subject: 'alice', name: null, email: null, roles, expiresAt: null },
  repo: 'site',
  updates: [
    {
      ref: 'refs/heads/main',
      oldSha: OLD,
      newSha: NEW,
      commits: [
        {
          sha: NEW,
          parents: [OLD],
          changes: [
            {
              path,
              change: 'added' as const,
              oldMode: null,
              newMode: '100644' as const,
              oldSha: null,
              newSha: OLD,
              size,
            },
          ],
        },
      ],
    },
  ],
});

describe('ExamplePushPolicy', () => {
  it('asks for changed paths', () => {
    expect(policy.needs()).toEqual({ changedPaths: true });
  });

  it('denies large files and protected paths for non-maintainers, and allows the rest', () => {
    expect(policy.check(input([], 'big.bin', 101)).refs[0]).toMatchObject({
      decision: 'deny',
      reason: expect.stringMatching(/big.bin is larger/),
    });
    expect(policy.check(input([], '.github/workflows/ci.yml', 10)).refs[0]).toMatchObject({
      decision: 'deny',
    });
    expect(policy.check(input(['maintainer'], '.github/workflows/ci.yml', 10)).refs[0]).toEqual({
      ref: 'refs/heads/main',
      decision: 'allow',
    });
    expect(policy.check(input([], 'README.md', 10)).refs[0]).toEqual({
      ref: 'refs/heads/main',
      decision: 'allow',
    });
  });
});
