// SPDX-License-Identifier: Apache-2.0
import { PolicyResult } from '@leed-ai/git-gateway-contract/proxy/policy-result';
import { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { describe, expect, it } from 'vite-plus/test';

import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';

const A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const alice = Principal.parse({ subject: 'alice', roles: ['maintainer'] });
const bob = Principal.parse({ subject: 'bob', roles: ['editor'] });
const carol = Principal.parse({ subject: 'carol' });

const policy = new RuleBranchPolicy({
  rules: [
    {
      pattern: 'refs/heads/main',
      pushers: { roles: ['maintainer'], subjects: ['carol'] },
      message: 'main is protected',
    },
    { pattern: 'refs/heads/sandbox/**', forcePush: true, delete: true },
    { pattern: 'refs/tags/**', create: false },
  ],
  fallback: { delete: false },
});

const decide = (principal: Principal, ref: string, oldSha: string, newSha: string) =>
  PolicyResult.parse(policy.check(principal, 'site', [{ ref, oldSha, newSha }])).refs[0];

describe('RuleBranchPolicy', () => {
  it('lets the named principals update a protected ref only as a fast-forward', () => {
    expect(decide(alice, 'refs/heads/main', A, B)).toEqual({
      ref: 'refs/heads/main',
      decision: 'fast-forward-only',
      reason: 'main is protected',
    });
    expect(decide(carol, 'refs/heads/main', A, B)?.decision).toBe('fast-forward-only');
    expect(decide(bob, 'refs/heads/main', A, B)).toEqual({
      ref: 'refs/heads/main',
      decision: 'deny',
      reason: 'main is protected',
    });
  });

  it('applies create and delete permissions', () => {
    expect(decide(alice, 'refs/heads/main', ZERO_SHA, B)?.decision).toBe('allow');
    expect(decide(alice, 'refs/heads/main', A, ZERO_SHA)?.decision).toBe('deny');
    expect(decide(bob, 'refs/tags/v1', ZERO_SHA, B)).toEqual({
      ref: 'refs/tags/v1',
      decision: 'deny',
      reason: 'creating tag v1 is not allowed',
    });
    expect(decide(bob, 'refs/heads/sandbox/a/b', A, ZERO_SHA)?.decision).toBe('allow');
  });

  it('allows any update where force pushes are allowed', () => {
    expect(decide(bob, 'refs/heads/sandbox/x', A, B)).toEqual({
      ref: 'refs/heads/sandbox/x',
      decision: 'allow',
    });
  });

  it('falls back for refs no rule matches', () => {
    expect(decide(bob, 'refs/heads/topic', ZERO_SHA, B)?.decision).toBe('allow');
    expect(decide(bob, 'refs/heads/topic', A, B)).toEqual({
      ref: 'refs/heads/topic',
      decision: 'fast-forward-only',
      reason: 'force-pushing topic is not allowed',
    });
    expect(decide(bob, 'refs/heads/topic', A, ZERO_SHA)).toEqual({
      ref: 'refs/heads/topic',
      decision: 'deny',
      reason: 'deleting topic is not allowed',
    });
  });

  it('defaults to allowing create and delete and refusing force pushes', () => {
    const open = new RuleBranchPolicy();
    expect(
      open.check(bob, 'site', [{ ref: 'refs/heads/x', oldSha: A, newSha: ZERO_SHA }]).refs[0]?.decision,
    ).toBe('allow');
    expect(open.check(bob, 'site', [{ ref: 'refs/heads/x', oldSha: A, newSha: B }]).refs[0]?.decision).toBe(
      'fast-forward-only',
    );
  });

  it('refuses everyone when a selector lists nobody', () => {
    const locked = new RuleBranchPolicy({ rules: [{ pattern: 'refs/heads/frozen', pushers: {} }] });
    expect(
      locked.check(alice, 'site', [{ ref: 'refs/heads/frozen', oldSha: A, newSha: B }]).refs[0],
    ).toMatchObject({
      decision: 'deny',
      reason: 'pushing to frozen is not allowed',
    });
  });

  it('validates its configuration', () => {
    expect(() => new RuleBranchPolicy({ rules: [{ pattern: 'refs/notes/x' }] })).toThrow(/Invalid string/);
  });
});
