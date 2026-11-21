// SPDX-License-Identifier: Apache-2.0
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import * as fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { buildCommit } from '../../src/commit/build-commit.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import { writePack } from '../../src/pack/write-pack.ts';
import { arbitraryContent, arbitraryPath, consistentPaths } from '../helpers/arbitraries.ts';
import { GIT, GitSandbox } from '../helpers/git.ts';
import { MemoryStore } from '../helpers/memory-store.ts';

const sandbox = new GitSandbox();
afterAll(() => sandbox.dispose());

let repoCount = 0;
const freshRepo = (): string => {
  repoCount += 1;
  return sandbox.bare(`pack-${repoCount}.git`);
};

const indexPack = (repo: string, pack: Uint8Array) =>
  sandbox.run(['--git-dir', repo, 'index-pack', '--strict', '--stdin'], { input: pack });

describe(`packs against ${GIT} index-pack --strict`, () => {
  it('accepts a pack of a complete commit and stores every object', async () => {
    const built = await buildCommit(
      {
        branch: 'main',
        base: null,
        actions: [
          { action: 'create', path: 'README.md', content: '# Site\n' },
          { action: 'create', path: 'scripts/build.sh', content: '#!/bin/sh\n' },
          { action: 'chmod', path: 'scripts/build.sh', executeFilemode: true },
          { action: 'create', path: 'assets/logo.bin', content: 'AAEC/w==', encoding: 'base64' },
        ],
        message: 'Initial',
        author: { name: 'Ada', email: 'ada@example.com' },
        idempotencyKey: 'k1',
        date: '2026-11-20T09:30:00.000Z',
      },
      new MemoryStore(),
    );
    if (built.status !== 'ready') throw new Error('expected a commit');
    const repo = freshRepo();
    const result = indexPack(repo, await writePack(built.objects));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    for (const object of built.objects) {
      expect(sandbox.text(['--git-dir', repo, 'cat-file', '-t', object.sha])).toBe(object.type);
      expect(sandbox.run(['--git-dir', repo, 'cat-file', object.type, object.sha]).stdout).toEqual(
        object.data,
      );
    }
    sandbox.text(['--git-dir', repo, 'update-ref', 'refs/heads/main', built.commit.sha]);
    expect(sandbox.run(['--git-dir', repo, 'fsck', '--strict', '--no-dangling']).status).toBe(0);
    expect(sandbox.text(['--git-dir', repo, 'ls-tree', '-r', 'main'])).toContain('100755 blob');
    expect(sandbox.run(['--git-dir', repo, 'cat-file', 'blob', 'main:assets/logo.bin']).stdout).toEqual(
      Uint8Array.of(0, 1, 2, 255),
    );
  });

  it('accepts packs of any generated commit', async () => {
    const files = fc
      .array(fc.tuple(arbitraryPath, arbitraryContent, fc.boolean()), { minLength: 1, maxLength: 10 })
      .map((list) => {
        const keep = new Set(consistentPaths(list.map(([path]) => path)));
        const seen = new Set<string>();
        return list.filter(([path]) => keep.has(path) && !seen.has(path) && seen.add(path) !== undefined);
      });
    await fc.assert(
      fc.asyncProperty(files, async (list) => {
        const actions: CommitActionInput[] = list.flatMap(
          ([path, content, executable]): CommitActionInput[] => [
            { action: 'create', path, content },
            ...(executable ? [{ action: 'chmod' as const, path, executeFilemode: true }] : []),
          ],
        );
        const built = await buildCommit(
          {
            branch: 'main',
            base: null,
            actions,
            message: 'Generated',
            author: { name: 'Ada', email: 'ada@example.com' },
            idempotencyKey: 'gen',
            date: '2026-11-20T09:30:00.000Z',
          },
          new MemoryStore(),
        );
        if (built.status !== 'ready') throw new Error('expected a commit');
        const result = indexPack(freshRepo(), await writePack(built.objects));
        expect([result.status, result.stderr]).toEqual([0, '']);
      }),
      { numRuns: 15 },
    );
  });

  it('accepts a pack holding large and incompressible blobs', async () => {
    const random = new Uint8Array(200_000);
    for (let index = 0; index < random.length; index += 65_536) {
      crypto.getRandomValues(random.subarray(index, Math.min(index + 65_536, random.length)));
    }
    const objects = [
      await createObject('blob', random),
      await createObject('blob', new Uint8Array(1_000_000)),
    ];
    const result = indexPack(freshRepo(), await writePack(objects));
    expect([result.status, result.stderr]).toEqual([0, '']);
  });

  it('is refused when corrupted, so the checksum is really checked', async () => {
    const pack = await writePack([await createObject('blob', new TextEncoder().encode('hello\n'))]);
    pack[pack.length - 1] = (pack[pack.length - 1] ?? 0) ^ 0xff;
    expect(indexPack(freshRepo(), pack).status).not.toBe(0);
  });
});
