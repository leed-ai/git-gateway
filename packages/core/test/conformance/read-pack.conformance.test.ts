// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import { readPack } from '../../src/pack/read-pack.ts';
import { GitSandbox } from '../helpers/git.ts';

// readPack against packs the git binary writes: deltified (OFS_DELTA) packs from pack-objects and
// thin packs (REF_DELTA against objects outside the pack) as a push sends them.

const sandbox = new GitSandbox();
afterAll(() => sandbox.dispose());

function repoWithHistory(name: string): string {
  const dir = sandbox.bare(name);
  const work = `${sandbox.dir}/${name}-work`;
  sandbox.text(['init', '-q', '--initial-branch=main', work]);
  const lines = Array.from({ length: 3000 }, (_, index) => `line ${index} ${'y'.repeat(30)}`);
  for (let round = 0; round < 4; round += 1) {
    lines[round * 500] = `edited in round ${round}`;
    writeFileSync(`${work}/file.txt`, `${lines.join('\n')}\n`);
    sandbox.text(['-C', work, 'add', 'file.txt']);
    sandbox.text(['-C', work, 'commit', '-q', '-m', `round ${round}`]);
  }
  sandbox.text(['-C', work, 'push', '-q', dir, 'main']);
  return dir;
}

describe('readPack with packs from git', () => {
  it('reads a deltified pack from pack-objects, every object matching cat-file', async () => {
    const repo = repoWithHistory('deltas');
    const revs = sandbox.text(['--git-dir', repo, 'rev-list', '--objects', 'main']);
    const pack = sandbox.run(['--git-dir', repo, 'pack-objects', '--stdout', '--window=50', '--depth=10'], {
      input: new TextEncoder().encode(
        `${revs
          .split('\n')
          .map((line) => line.split(' ')[0])
          .join('\n')}\n`,
      ),
    });
    expect(pack.status).toBe(0);
    const objects = await readPack(pack.stdout);
    expect(objects.length).toBe(revs.split('\n').length);
    for (const object of objects) {
      const type = sandbox.text(['--git-dir', repo, 'cat-file', '-t', object.sha]);
      expect(type).toBe(object.type);
      const content = sandbox.run(['--git-dir', repo, 'cat-file', object.type, object.sha]).stdout;
      expect(Buffer.from(content).equals(Buffer.from(object.data))).toBe(true);
    }
  });

  it('reads a thin pack, resolving bases the pack leaves out', async () => {
    const repo = repoWithHistory('thin');
    const head = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const parent = sandbox.text(['--git-dir', repo, 'rev-parse', 'main~1']);
    const pack = sandbox.run(['--git-dir', repo, 'pack-objects', '--stdout', '--thin', '--revs'], {
      input: new TextEncoder().encode(`${head}\n^${parent}\n`),
    });
    expect(pack.status).toBe(0);
    const objects = await readPack(pack.stdout, {
      lookupBase: async (sha) => {
        const type = sandbox.run(['--git-dir', repo, 'cat-file', '-t', sha]);
        if (type.status !== 0) return null;
        const kind = new TextDecoder().decode(type.stdout).trim();
        if (kind !== 'blob' && kind !== 'tree' && kind !== 'commit') return null;
        return { type: kind, sha, data: sandbox.run(['--git-dir', repo, 'cat-file', kind, sha]).stdout };
      },
    });
    expect(objects.map((object) => object.sha)).toContain(head);
    const file = objects.find((object) => object.type === 'blob');
    expect(new TextDecoder().decode(file?.data)).toContain('edited in round 3');
  });
});
