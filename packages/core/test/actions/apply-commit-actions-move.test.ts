// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { apply, errorOf, sha } from '../helpers/action-fixture.ts';

describe('move', () => {
  it('moves a file, keeping its content and mode', async () => {
    const files = await apply([{ action: 'move', previousPath: 'scripts/build.sh', path: 'bin/build.sh' }]);
    expect(files.has('scripts/build.sh')).toBe(false);
    expect(files.get('bin/build.sh')).toMatchObject({ mode: '100755', sha: await sha('#!/bin/sh\n') });
  });

  it('moves a file with new content', async () => {
    const files = await apply([
      { action: 'move', previousPath: 'README.md', path: 'docs/README.md', content: 'new' },
    ]);
    expect(files.get('docs/README.md')).toMatchObject({ mode: '100644', sha: await sha('new') });
  });

  it('moves a file beneath its own old path, and back', async () => {
    const down = await apply([{ action: 'move', previousPath: 'README.md', path: 'README.md/index.md' }]);
    expect(down.get('README.md/index.md')).toMatchObject({ sha: await sha('# Site\n') });
    const up = await apply([{ action: 'move', previousPath: 'content/blog/one.md', path: 'content/blog' }]);
    expect(up.get('content/blog')).toMatchObject({ sha: await sha('One\n') });
  });

  it.each([
    [
      'a missing source',
      { previousPath: 'missing.md', path: 'x.md' },
      { code: 'path_not_found', details: { path: 'missing.md' } },
    ],
    [
      'a directory source',
      { previousPath: 'content', path: 'x' },
      { code: 'path_not_found', details: { path: 'content' } },
    ],
    [
      'an existing destination',
      { previousPath: 'README.md', path: 'content/about.md' },
      { code: 'path_exists', details: { path: 'content/about.md' } },
    ],
    [
      'a directory destination',
      { previousPath: 'README.md', path: 'scripts' },
      { code: 'path_exists', details: { path: 'scripts' } },
    ],
    [
      'a destination beneath a file',
      { previousPath: 'README.md', path: 'current/x' },
      { code: 'path_conflict', details: { path: 'current/x', conflictingPath: 'current' } },
    ],
  ])('fails on %s', async (_, paths, expected) => {
    expect(await errorOf([{ action: 'move', ...paths }])).toEqual(expected);
  });
});

describe('chmod', () => {
  it('sets and clears the executable bit', async () => {
    const set = await apply([{ action: 'chmod', path: 'README.md', executeFilemode: true }]);
    expect(set.get('README.md')?.mode).toBe('100755');
    const cleared = await apply([{ action: 'chmod', path: 'scripts/build.sh', executeFilemode: false }]);
    expect(cleared.get('scripts/build.sh')?.mode).toBe('100644');
  });

  it('leaves a symbolic link as it is', async () => {
    expect(
      (await apply([{ action: 'chmod', path: 'current', executeFilemode: true }])).get('current')?.mode,
    ).toBe('120000');
  });

  it.each(['missing.sh', 'scripts', 'vendor/lib'])('fails with path_not_found on %s', async (path) => {
    expect(await errorOf([{ action: 'chmod', path, executeFilemode: true }])).toEqual({
      code: 'path_not_found',
      details: { path },
    });
  });
});
