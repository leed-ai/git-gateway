// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { isBase64 } from '../../src/schemas/content-encoding.ts';
import {
  BranchName,
  FilePath,
  FullRefName,
  IdempotencyKey,
  RepoName,
  Revision,
} from '../../src/schemas/names.ts';
import { Sha } from '../../src/schemas/sha.ts';

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: string) =>
  schema.safeParse(value).success;

describe('names', () => {
  it.each(['acme', 'acme-raw-content', 'site.example', 'A_1'])('RepoName accepts %s', (name) => {
    expect(accepts(RepoName, name)).toBe(true);
  });
  it.each(['', '-x', '.x', 'a/b', 'a b', 'repo.git', 'REPO.GIT', 'x'.repeat(101)])(
    'RepoName rejects %j',
    (name) => {
      expect(accepts(RepoName, name)).toBe(false);
    },
  );

  it.each(['main', 'staging', 'feature/x', 'release-1.2', 'ü', 'a/-b'])('BranchName accepts %s', (name) => {
    expect(accepts(BranchName, name)).toBe(true);
  });
  it.each([
    '',
    'HEAD',
    '-x',
    '.x',
    'a/.b',
    'a.lock',
    'a/b.lock/c',
    'a..b',
    'a@{b',
    '@',
    'a b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'x/',
    'x.',
    'a//b',
    '/a',
    'refs/heads/x',
    'a\u0000b',
    'a\u007fb',
    '0123456789abcdef0123456789abcdef01234567',
    'f'.repeat(40),
  ])('BranchName rejects %j', (name) => {
    expect(accepts(BranchName, name)).toBe(false);
  });

  it('BranchName accepts hex names a Revision cannot mistake for a commit id', () => {
    expect(accepts(BranchName, 'f'.repeat(39))).toBe(true);
    expect(accepts(BranchName, 'f'.repeat(41))).toBe(true);
    expect(accepts(BranchName, 'F'.repeat(40))).toBe(true);
    expect(accepts(BranchName, `x/${'f'.repeat(40)}`)).toBe(true);
  });

  it('FilePath caps each segment at 255 characters, the tree entry name limit', () => {
    expect(accepts(FilePath, 'x'.repeat(255))).toBe(true);
    expect(accepts(FilePath, `d/${'x'.repeat(255)}/e`)).toBe(true);
    expect(accepts(FilePath, 'x'.repeat(256))).toBe(false);
    expect(accepts(FilePath, `d/${'x'.repeat(300)}`)).toBe(false);
    expect(accepts(FilePath, `${'x'.repeat(256)}/d`)).toBe(false);
    expect(accepts(FilePath, `a/${'x'.repeat(256)}/b`)).toBe(false);
  });

  it('FullRefName takes refs/heads and refs/tags only', () => {
    expect(accepts(FullRefName, 'refs/heads/main')).toBe(true);
    expect(accepts(FullRefName, 'refs/tags/v1.0.0')).toBe(true);
    expect(accepts(FullRefName, 'refs/tags/v')).toBe(true);
    expect(accepts(FullRefName, 'refs/heads/x')).toBe(true);
    expect(accepts(FullRefName, 'refs/tags/')).toBe(false);
    expect(accepts(FullRefName, 'refs/heads/')).toBe(false);
    expect(accepts(FullRefName, 'refs/remotes/origin/main')).toBe(false);
    expect(accepts(FullRefName, 'refs/heads/a..b')).toBe(false);
    expect(accepts(FullRefName, 'main')).toBe(false);
  });

  it.each([
    'a',
    'content/index.md',
    'données/résumé ✓.md',
    '.github/workflows/ci.yml',
    'a.git.md',
    'x/.gitignore',
  ])('FilePath accepts %s', (path) => {
    expect(accepts(FilePath, path)).toBe(true);
  });
  it.each([
    '',
    '/a',
    'a/',
    'a//b',
    '.',
    '..',
    'a/./b',
    'a/../b',
    '.git',
    'x/.GIT/config',
    'a\\b',
    'a\u0000b',
    'a\n/../b',
    'x\n/.git/config',
    'a\n/.GIT/hooks/pre-commit',
    'a\n//b',
    'a\n/',
    'a\r/./b',
    '\n/a',
    'x/.Git',
    'a\nb',
    'a\tb',
    'a\u001fb',
    'a\u007fb',
  ])('FilePath rejects %j', (path) => {
    expect(accepts(FilePath, path)).toBe(false);
  });

  it('Sha takes 40 lowercase hex characters only', () => {
    expect(accepts(Sha, 'a'.repeat(40))).toBe(true);
    expect(accepts(Sha, 'A'.repeat(40))).toBe(false);
    expect(accepts(Sha, 'a'.repeat(39))).toBe(false);
  });

  it('Revision takes a sha or a branch', () => {
    expect(accepts(Revision, 'f'.repeat(40))).toBe(true);
    expect(accepts(Revision, 'main')).toBe(true);
    expect(accepts(Revision, 'a..b')).toBe(false);
  });

  it('IdempotencyKey bounds length and characters', () => {
    expect(accepts(IdempotencyKey, 'cms:publish:1')).toBe(true);
    expect(accepts(IdempotencyKey, 'k'.repeat(129))).toBe(false);
    expect(accepts(IdempotencyKey, 'has space')).toBe(false);
    expect(accepts(IdempotencyKey, ':leading')).toBe(false);
  });
});

const hasControlOrBackslash = (path: string) => {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
};

const isSafePath = (path: string) =>
  !hasControlOrBackslash(path) &&
  path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment.length <= 255 &&
        segment !== '.' &&
        segment !== '..' &&
        segment.toLowerCase() !== '.git',
    );

const PublishedSchema = z.object({ $defs: z.object({ FilePath: z.object({ pattern: z.string() }) }) });

describe('FilePath (property)', () => {
  const pathString = fc
    .array(
      fc.constantFrom('a', 'g', 'G', 'i', 'I', 't', 'T', '.', '/', '\n', '\r', '\t', '\u007f', '\\', ' '),
      {
        minLength: 1,
        maxLength: 16,
      },
    )
    .map((chars) => chars.join(''));

  it('accepts exactly the paths whose segments are all safe', () => {
    fc.assert(
      fc.property(pathString, (path) => {
        expect(accepts(FilePath, path)).toBe(isSafePath(path));
      }),
      { numRuns: 2000 },
    );
  });

  it('gives the same verdict through the flag-less JSON Schema pattern', () => {
    const { pattern } = PublishedSchema.parse(z.toJSONSchema(FilePath)).$defs.FilePath;
    expect(pattern).toMatch(/^\^/);
    const published = new RegExp(pattern, 'u');
    fc.assert(
      fc.property(pathString, (path) => {
        expect(published.test(path)).toBe(accepts(FilePath, path));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('isBase64 (property)', () => {
  it('accepts every standard base64 encoding', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(isBase64(Buffer.from(bytes).toString('base64'))).toBe(true);
      }),
    );
  });

  it('rejects unpadded, url-safe and stray-character forms', () => {
    for (const bad of ['YQ', 'YWI', '-_8=', 'YQ==YQ==', 'Y Q==', 'YQ=', 'Y===', '====', 'Y=Q=', 'YQ==\n'])
      expect(isBase64(bad)).toBe(false);
  });
});
