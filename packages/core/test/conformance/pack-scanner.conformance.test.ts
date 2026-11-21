// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import { decodeCommit } from '../../src/objects/commit-object.ts';
import { PackScanner } from '../../src/pack/pack-scanner.ts';
import { GitSandbox } from '../helpers/git.ts';

// PackScanner against packs the git binary writes, fed in small chunks: every commit and its
// parents must match `git rev-list --parents`.

const sandbox = new GitSandbox();
afterAll(() => sandbox.dispose());

function history(name: string): { repo: string; work: string } {
  const repo = sandbox.bare(name);
  const work = `${sandbox.dir}/${name}-work`;
  sandbox.text(['init', '-q', '--initial-branch=main', work]);
  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'z'.repeat(30)}`);
  for (let round = 0; round < 6; round += 1) {
    lines[round * 300] = `edited in round ${round}`;
    writeFileSync(`${work}/file.txt`, `${lines.join('\n')}\n`);
    sandbox.text(['-C', work, 'add', 'file.txt']);
    sandbox.text(['-C', work, 'commit', '-q', '-m', `round ${round}`]);
    if (round === 2) {
      sandbox.text(['-C', work, 'checkout', '-q', '-b', 'side']);
      writeFileSync(`${work}/side.txt`, 'side\n');
      sandbox.text(['-C', work, 'add', 'side.txt']);
      sandbox.text(['-C', work, 'commit', '-q', '-m', 'side']);
      sandbox.text(['-C', work, 'checkout', '-q', 'main']);
      sandbox.text(['-C', work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    }
  }
  sandbox.text(['-C', work, 'push', '-q', repo, 'main']);
  return { repo, work };
}

async function scanChunked(pack: Uint8Array, size: number) {
  const scanner = new PackScanner();
  for (let offset = 0; offset < pack.length; offset += size)
    await scanner.push(pack.subarray(offset, offset + size));
  return scanner.finish();
}

function expectedParents(repo: string, range: readonly string[]): Map<string, string[]> {
  const out = sandbox.text(['--git-dir', repo, 'rev-list', '--parents', ...range]);
  return new Map(
    out.split('\n').map((line) => {
      const [sha = '', ...parents] = line.split(' ');
      return [sha, parents];
    }),
  );
}

describe('PackScanner with packs from git', () => {
  it.each([
    ['OFS_DELTA', ['--delta-base-offset'], false],
    ['REF_DELTA', [], true],
  ])('finds every commit of a deltified full pack (%s bases)', async (kind, flags, hasUnresolved) => {
    const { repo } = history(`full-${kind}`);
    const pack = sandbox.run(
      ['--git-dir', repo, 'pack-objects', '--stdout', '--revs', '--window=50', '--depth=20', ...flags],
      { input: new TextEncoder().encode('main\n') },
    );
    expect(pack.status).toBe(0);
    const result = await scanChunked(pack.stdout, 333);
    expect(new Map(result.commits)).toEqual(expectedParents(repo, ['main']));
    // REF_DELTA entries against trees and blobs cannot be typed without their bases; OFS ones can.
    expect(result.unresolved > 0).toBe(hasUnresolved);
  });

  it('finds the new commits of a thin pack as a push sends it', async () => {
    const { repo } = history('thin');
    const pack = sandbox.run(['--git-dir', repo, 'pack-objects', '--stdout', '--thin', '--revs'], {
      input: new TextEncoder().encode('main\n^main~2\n'),
    });
    expect(pack.status).toBe(0);
    const result = await scanChunked(pack.stdout, 17);
    expect(new Map(result.commits)).toEqual(expectedParents(repo, ['main', '^main~2']));
  });

  it('ignores a parent line git ignores: a parent after the committer makes a root commit to git', async () => {
    const { repo } = history('misplaced-parent');
    const head = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const tree = sandbox.text(['--git-dir', repo, 'rev-parse', 'main^{tree}']);
    const ident = 'Ada <ada@example.com> 1700000000 +0000';
    const content = new TextEncoder().encode(
      `tree ${tree}\nauthor ${ident}\ncommitter ${ident}\nparent ${head}\n\ncrafted\n`,
    );
    const crafted = sandbox.text(
      ['--git-dir', repo, 'hash-object', '-t', 'commit', '--literally', '-w', '--stdin'],
      { input: content },
    );
    // git itself sees no parents: to git this commit is a root, not a descendant of main.
    expect(sandbox.text(['--git-dir', repo, 'rev-list', '--parents', '-n', '1', crafted])).toBe(crafted);
    expect(sandbox.run(['--git-dir', repo, 'merge-base', '--is-ancestor', head, crafted]).status).toBe(1);
    const pack = sandbox.run(['--git-dir', repo, 'pack-objects', '--stdout'], {
      input: new TextEncoder().encode(`${crafted}\n`),
    });
    expect(pack.status).toBe(0);
    const result = await scanChunked(pack.stdout, 11);
    expect(result.commits.has(crafted)).toBe(false);
    expect(result.malformed).toBe(1);
    expect(() => decodeCommit(crafted, content)).toThrow(
      expect.objectContaining({
        body: expect.objectContaining({
          details: expect.objectContaining({ reason: expect.stringMatching(/parent lines/) }),
        }),
      }),
    );
  });
});
