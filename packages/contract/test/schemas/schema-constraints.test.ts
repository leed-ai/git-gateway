// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';
import type { z } from 'zod';

import { CommitInput } from '../../src/rpc/commit.ts';
import { ListTreeInput } from '../../src/rpc/list-tree.ts';
import { LogInput } from '../../src/rpc/log.ts';
import { MintReadTokenInput } from '../../src/rpc/mint-read-token.ts';
import { PromoteInput } from '../../src/rpc/promote.ts';
import { FileRead } from '../../src/rpc/read-file.ts';
import { SyncBranchInput } from '../../src/rpc/sync-branch.ts';
import { CommitAction } from '../../src/schemas/commit-action.ts';
import { GatewayConfig, IdempotencyConfig, SyncRule } from '../../src/schemas/gateway-config.ts';
import { Identity, Timestamp } from '../../src/schemas/identity.ts';

// Constraints the contract encodes in its schemas (spec → Dependencies: "constraints live in the
// schema, not in prose alone"), checked from both sides.

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const AUTHOR = { name: 'Ada', email: 'ada@example.com' };
const SHA = 'a'.repeat(40);

describe('CommitAction', () => {
  it('defaults encoding to text on every content-carrying action', () => {
    for (const action of ['create', 'update', 'upsert'] as const) {
      expect(CommitAction.parse({ action, path: 'a', content: 'x' })).toMatchObject({ encoding: 'text' });
    }
    expect(CommitAction.parse({ action: 'move', path: 'b', previousPath: 'a' })).toMatchObject({
      encoding: 'text',
    });
  });

  it('accepts an empty file', () => {
    expect(ok(CommitAction, { action: 'create', path: 'a', content: '' })).toBe(true);
    expect(ok(CommitAction, { action: 'create', path: 'a', content: '', encoding: 'base64' })).toBe(true);
  });

  it.each(['create', 'update', 'upsert', 'move'] as const)(
    '%s refuses invalid base64 and names the content field',
    (action) => {
      const result = CommitAction.safeParse({
        action,
        path: 'b',
        previousPath: action === 'move' ? 'a' : undefined,
        content: 'not base64!',
        encoding: 'base64',
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('content');
    },
  );

  it('checks base64 content of 10 MiB and more without overflowing the regex stack', () => {
    const large = Buffer.alloc(12 * 1024 * 1024, 0xa5).toString('base64');
    expect(large.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(ok(CommitAction, { action: 'create', path: 'a', content: large, encoding: 'base64' })).toBe(true);
    const corrupt = `${large.slice(0, -4)}!AAA`;
    expect(() =>
      CommitAction.safeParse({ action: 'create', path: 'a', content: corrupt, encoding: 'base64' }),
    ).not.toThrow();
    expect(ok(CommitAction, { action: 'create', path: 'a', content: corrupt, encoding: 'base64' })).toBe(
      false,
    );
  });

  it('accepts base64 content at the full 48 MiB character limit and refuses one quad more', () => {
    const atLimit = Buffer.alloc(36 * 1024 * 1024).toString('base64');
    expect(atLimit.length).toBe(48 * 1024 * 1024);
    expect(ok(CommitAction, { action: 'upsert', path: 'a', content: atLimit, encoding: 'base64' })).toBe(
      true,
    );
    expect(
      ok(CommitAction, { action: 'upsert', path: 'a', content: `${atLimit}AAAA`, encoding: 'base64' }),
    ).toBe(false);
  });

  it('does not check text content as base64', () => {
    expect(ok(CommitAction, { action: 'create', path: 'a', content: 'not base64!' })).toBe(true);
  });

  it('refuses a move onto its own path', () => {
    expect(ok(CommitAction, { action: 'move', path: 'a', previousPath: 'a' })).toBe(false);
  });

  it.each([
    { action: 'create', path: 'a' },
    { action: 'update', path: 'a' },
    { action: 'move', path: 'a' },
    { action: 'chmod', path: 'a' },
    { action: 'delete', path: 'a', content: 'x' },
    { action: 'chmod', path: 'a', executeFilemode: 'yes' },
    { action: 'rename', path: 'a', previousPath: 'b' },
    { action: 'create', path: '../a', content: 'x' },
    { action: 'create', path: 'a', content: 'x', encoding: 'hex' },
  ])('refuses %j', (value) => {
    expect(ok(CommitAction, value)).toBe(false);
  });

  it('refuses content beyond 48 MiB of characters', () => {
    const big = 'x'.repeat(48 * 1024 * 1024 + 1);
    expect(ok(CommitAction, { action: 'create', path: 'a', content: big })).toBe(false);
  });

  it('accepts base64 of arbitrary bytes on every content action (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 64 }),
        fc.constantFrom('create', 'update', 'upsert'),
        (bytes, action) => {
          const content = Buffer.from(bytes).toString('base64');
          expect(ok(CommitAction, { action, path: 'a', content, encoding: 'base64' })).toBe(true);
        },
      ),
    );
  });
});

describe('CommitInput', () => {
  const base = {
    repo: 'r',
    branch: 'main',
    message: 'm',
    author: AUTHOR,
    idempotencyKey: 'k',
    actions: [{ action: 'delete', path: 'a' }],
  };

  it('accepts the minimal input', () => {
    expect(ok(CommitInput, base)).toBe(true);
  });

  it.each([
    ['an empty message', { message: '' }],
    ['a blank message', { message: ' \n\t' }],
    ['an over-long message', { message: 'm'.repeat(65_537) }],
    ['no actions', { actions: [] }],
    ['more than 1000 actions', { actions: Array.from({ length: 1001 }, () => base.actions[0]) }],
    ['a malformed expectedHead', { expectedHead: 'A'.repeat(40) }],
    ['an author with an angle bracket', { author: { name: 'A <b>', email: 'a@example.com' } }],
    ['an author without an email', { author: { name: 'Ada' } }],
    ['a branch given as a full ref', { branch: 'refs/heads/main' }],
  ])('refuses %s', (_name, patch) => {
    expect(ok(CommitInput, { ...base, ...patch })).toBe(false);
  });

  it('accepts exactly 1000 actions and a null expectedHead', () => {
    expect(ok(CommitInput, { ...base, actions: Array.from({ length: 1000 }, () => base.actions[0]) })).toBe(
      true,
    );
    expect(ok(CommitInput, { ...base, expectedHead: null })).toBe(true);
  });
});

describe('read and branch inputs', () => {
  it('LogInput bounds limit and offset and defaults them', () => {
    expect(LogInput.parse({ repo: 'r', ref: 'main' })).toMatchObject({ limit: 50, offset: 0 });
    for (const limit of [0, 501, 1.5]) expect(ok(LogInput, { repo: 'r', ref: 'main', limit })).toBe(false);
    expect(ok(LogInput, { repo: 'r', ref: 'main', offset: -1 })).toBe(false);
    expect(ok(LogInput, { repo: 'r', ref: 'main', since: '2026-11-20' })).toBe(false);
  });

  it('ListTreeInput defaults to one level', () => {
    expect(ListTreeInput.parse({ repo: 'r', ref: 'main' })).toMatchObject({ recursive: false });
  });

  it('MintReadTokenInput bounds ttlSeconds to 60–86400, default 3600', () => {
    expect(MintReadTokenInput.parse({ repo: 'r' }).ttlSeconds).toBe(3600);
    expect(ok(MintReadTokenInput, { repo: 'r', ttlSeconds: 59 })).toBe(false);
    expect(ok(MintReadTokenInput, { repo: 'r', ttlSeconds: 86_401 })).toBe(false);
    expect(ok(MintReadTokenInput, { repo: 'r', ttlSeconds: 86_400 })).toBe(true);
  });

  it('syncBranch and promote refuse from equal to into', () => {
    expect(ok(SyncBranchInput, { repo: 'r', from: 'main', into: 'main' })).toBe(false);
    expect(ok(PromoteInput, { repo: 'r', from: 'main', into: 'main', sha: SHA })).toBe(false);
    expect(ok(PromoteInput, { repo: 'r', from: 'staging', into: 'main', sha: SHA })).toBe(true);
  });
});

describe('FileRead', () => {
  it('returns content beyond the 48 MiB write limit, since base64 output is 4/3 the bytes', () => {
    const content = 'A'.repeat(48 * 1024 * 1024 + 4);
    const read = {
      path: 'big.txt',
      commit: SHA,
      sha: SHA,
      size: 36 * 1024 * 1024 + 3,
      executable: false,
      encoding: 'base64',
      content,
    };
    expect(ok(FileRead, read)).toBe(true);
  });
});

describe('Identity and Timestamp', () => {
  it.each([
    { name: '', email: 'a@example.com' },
    { name: 'a\nb', email: 'a@example.com' },
    { name: 'a', email: 'not-an-email' },
    { name: 'a', email: 'a@example.com', extra: 1 },
  ])('Identity refuses %j', (value) => {
    expect(ok(Identity, value)).toBe(false);
  });

  it('Timestamp takes UTC ISO 8601 only', () => {
    expect(ok(Timestamp, '2026-11-20T09:30:00Z')).toBe(true);
    expect(ok(Timestamp, '2026-11-20T09:30:00.000Z')).toBe(true);
    expect(ok(Timestamp, '2026-11-20T09:30:00+01:00')).toBe(false);
    expect(ok(Timestamp, '2026-11-20')).toBe(false);
  });
});

describe('GatewayConfig', () => {
  it('{} is a complete configuration with the documented defaults', () => {
    expect(GatewayConfig.parse({})).toEqual({
      publicBaseUrl: 'https://git.example.com',
      serviceIdentity: { name: 'git-gateway', email: 'git-gateway@noreply.invalid' },
      idempotency: { maxCommits: 200, maxAgeSeconds: 604_800 },
      inlineRetries: 3,
      authCacheSeconds: 60,
      syncRules: [],
    });
  });

  it('fills one idempotency bound when only the other is given', () => {
    expect(IdempotencyConfig.parse({ maxCommits: 5 })).toEqual({ maxCommits: 5, maxAgeSeconds: 604_800 });
  });

  it.each([
    { publicBaseUrl: 'ftp://git.example.com' },
    { publicBaseUrl: 'not a url' },
    { inlineRetries: 11 },
    { authCacheSeconds: 3601 },
    { idempotency: { maxCommits: 0 } },
    { idempotency: { maxAgeSeconds: 59 } },
    { idempotency: { maxAgeSeconds: 30 * 24 * 3600 + 1 } },
    { syncRules: [{ from: 'main', into: 'main' }] },
    { syncRules: Array.from({ length: 51 }, () => ({ from: 'main', into: 'staging' })) },
    { unknown: true },
  ])('refuses %j', (value) => {
    expect(ok(GatewayConfig, value)).toBe(false);
  });

  it('SyncRule names the into field when from equals into', () => {
    const result = SyncRule.safeParse({ from: 'main', into: 'main' });
    expect(result.error?.issues[0]?.path).toEqual(['into']);
  });
});
