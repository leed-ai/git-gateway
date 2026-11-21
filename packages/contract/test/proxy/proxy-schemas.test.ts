// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { AuditEvent } from '../../src/proxy/audit-event.ts';
import { BranchPolicyConfig, BranchRule, RefPattern } from '../../src/proxy/branch-rule.ts';
import { PolicyResult } from '../../src/proxy/policy-result.ts';
import { Principal } from '../../src/proxy/principal.ts';
import { SmartHttpConfig } from '../../src/proxy/smart-http-config.ts';

describe('proxy schemas', () => {
  it('fills principal defaults and refuses credentials-shaped junk', () => {
    expect(Principal.parse({ subject: 'user:1' })).toEqual({
      subject: 'user:1',
      name: null,
      email: null,
      roles: [],
      expiresAt: null,
    });
    expect(Principal.safeParse({ subject: '' }).success).toBe(false);
    expect(Principal.safeParse({ subject: 'a\nb' }).success).toBe(false);
    expect(Principal.safeParse({ subject: 'a', roles: ['has space'] }).success).toBe(false);
    expect(Principal.safeParse({ subject: 'a', token: 'x' }).success).toBe(false);
  });

  it('accepts ref globs over branches and tags only', () => {
    for (const ok of ['refs/heads/main', 'refs/heads/**', 'refs/tags/v*', 'refs/heads/release/*/x'])
      expect(RefPattern.safeParse(ok).success).toBe(true);
    for (const bad of [
      'refs/notes/x',
      'refs/heads/',
      'refs/heads/a//b',
      'refs/heads/a..b',
      'refs/heads/a b',
      'refs/heads/***',
      'refs/heads/a?',
    ])
      expect(RefPattern.safeParse(bad).success).toBe(false);
  });

  it('defaults a rule to protecting its refs and the fallback to open-but-no-force', () => {
    expect(BranchRule.parse({ pattern: 'refs/heads/main' })).toEqual({
      pattern: 'refs/heads/main',
      pushers: null,
      create: true,
      delete: false,
      forcePush: false,
      message: null,
    });
    expect(BranchPolicyConfig.parse({})).toEqual({
      rules: [],
      fallback: { pushers: null, create: true, delete: true, forcePush: false },
    });
  });

  it('requires a reason for every refusal and one line per reason', () => {
    expect(PolicyResult.safeParse({ refs: [{ ref: 'refs/heads/main', decision: 'deny' }] }).success).toBe(
      false,
    );
    expect(
      PolicyResult.safeParse({ refs: [{ ref: 'refs/heads/main', decision: 'deny', reason: 'a\nb' }] })
        .success,
    ).toBe(false);
    expect(PolicyResult.safeParse({ refs: [{ ref: 'refs/notes/x', decision: 'allow' }] }).success).toBe(
      false,
    );
  });

  it('refuses a result naming one ref twice, and accepts distinct refs', () => {
    const twice = PolicyResult.safeParse({
      refs: [
        { ref: 'refs/heads/main', decision: 'deny', reason: 'main is protected' },
        { ref: 'refs/heads/main', decision: 'allow' },
      ],
    });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues).toMatchObject([
      { path: ['refs', 1, 'ref'], message: expect.stringContaining('refs/heads/main') },
    ]);
    expect(
      PolicyResult.safeParse({
        refs: [
          { ref: 'refs/heads/main', decision: 'allow' },
          { ref: 'refs/heads/dev', decision: 'allow' },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a result exactly when no ref repeats, flagging every repeat at its later index (property)', () => {
    const decision = fc.oneof(
      fc.record({
        ref: fc.constantFrom('refs/heads/main', 'refs/heads/dev', 'refs/tags/v1'),
        decision: fc.constant('allow' as const),
      }),
      fc.record({
        ref: fc.constantFrom('refs/heads/main', 'refs/heads/dev', 'refs/tags/v1'),
        decision: fc.constantFrom('deny' as const, 'fast-forward-only' as const),
        reason: fc.constant('refused'),
      }),
    );
    fc.assert(
      fc.property(fc.array(decision, { maxLength: 8 }), (refs) => {
        const repeats = refs.flatMap((entry, index) =>
          refs.slice(0, index).some((earlier) => earlier.ref === entry.ref) ? [index] : [],
        );
        const parsed = PolicyResult.safeParse({ refs });
        expect(parsed.success).toBe(repeats.length === 0);
        expect((parsed.error?.issues ?? []).map((issue) => issue.path)).toEqual(
          repeats.map((index) => ['refs', index, 'ref']),
        );
      }),
    );
  });

  it('bounds a reason to 1–500 characters and refuses a NUL, for every refusing decision', () => {
    for (const decision of ['deny', 'fast-forward-only'] as const) {
      const parse = (reason: string) =>
        PolicyResult.safeParse({ refs: [{ ref: 'refs/heads/main', decision, reason }] }).success;
      expect(parse('x'.repeat(500))).toBe(true);
      expect(parse('x'.repeat(501))).toBe(false);
      expect(parse('')).toBe(false);
      expect(parse('a\0b')).toBe(false);
    }
  });

  it('defaults every smart-HTTP limit', () => {
    expect(SmartHttpConfig.parse({})).toEqual({
      realm: 'git-gateway',
      maxPushHeadBytes: 8_388_608,
      maxAncestryReads: 2000,
      maxScannedCommitBytes: 33_554_432,
      decisionCacheEntries: 10_000,
      maxAuditReportBytes: 1_048_576,
      allowedPushOptions: [],
    });
    expect(SmartHttpConfig.safeParse({ realm: 'a"b' }).success).toBe(false);
  });

  it('allows push option names only, without whitespace, NUL or "="', () => {
    expect(SmartHttpConfig.parse({ allowedPushOptions: ['ci.skip'] }).allowedPushOptions).toEqual([
      'ci.skip',
    ]);
    for (const name of ['', 'ci.variable=A', 'two words', 'a\0b', 'x'.repeat(101)]) {
      expect(SmartHttpConfig.safeParse({ allowedPushOptions: [name] }).success).toBe(false);
    }
  });

  it('audits refs of any namespace but never an unknown field', () => {
    const event = {
      requestId: 'r-1',
      at: '2026-11-20T09:30:00.000Z',
      principal: { subject: 'user:42' },
      repo: 'site',
      operation: 'write',
      endpoint: 'receive-pack',
      outcome: 'denied',
      reason: 'only branches and tags',
      refs: [
        {
          ref: 'refs/notes/commits',
          oldSha: '0'.repeat(40),
          newSha: 'a'.repeat(40),
          status: 'rejected',
          reason: 'no',
        },
      ],
    };
    expect(AuditEvent.safeParse(event).success).toBe(true);
    expect(AuditEvent.safeParse({ ...event, credential: 'x' }).success).toBe(false);
  });
});
