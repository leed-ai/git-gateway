// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { shippedSourceImports } from '../src/package-imports.ts';
import { listWorkspacePackages, readManifest } from '../src/workspace.ts';

const roots: string[] = [];
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'repo-tools-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('listWorkspacePackages', () => {
  it('lists the root and every package matched by the workspaces globs', () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*', 'examples/*'] }),
      'packages/b/package.json': JSON.stringify({ name: 'b' }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      'packages/not-a-package/README.md': '',
      'examples/e/package.json': JSON.stringify({ name: 'e', private: true }),
    });
    expect(listWorkspacePackages(root).map(({ dir, manifest }) => [dir, manifest.name])).toEqual([
      ['.', 'root'],
      ['examples/e', 'e'],
      ['packages/a', 'a'],
      ['packages/b', 'b'],
    ]);
  });
});

describe('shippedSourceImports', () => {
  it('reads imports from src, skipping tests and other directories', () => {
    const root = fixture({
      'src/a.ts': "import { z } from 'zod';",
      'src/nested/b.ts': "import { Hono } from 'hono';",
      'src/a.test.ts': "import fc from 'fast-check';",
      'test/c.ts': "import Cloudflare from 'cloudflare';",
    });
    expect([...shippedSourceImports(root)].toSorted()).toEqual(['hono', 'zod']);
  });
});

describe('readManifest', () => {
  it('keeps fields it does not model and rejects a malformed manifest', () => {
    const root = fixture({
      'good/package.json': JSON.stringify({ name: 'x', scripts: { test: 'vp test' } }),
      'bad/package.json': JSON.stringify({ name: 'x', peerDependencies: { zod: 4 } }),
    });
    expect(readManifest(join(root, 'good/package.json'))).toEqual({
      name: 'x',
      scripts: { test: 'vp test' },
    });
    expect(() => readManifest(join(root, 'bad/package.json'))).toThrow(/peerDependencies/);
  });
});
