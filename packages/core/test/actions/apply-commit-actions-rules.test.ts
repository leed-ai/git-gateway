// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { apply, errorOf, sha } from '../helpers/action-fixture.ts';

describe('create', () => {
  it('creates a non-executable file, with parent directories', async () => {
    const files = await apply([{ action: 'create', path: 'content/new/page.md', content: 'New\n' }]);
    expect(files.get('content/new/page.md')).toEqual({
      name: 'page.md',
      mode: '100644',
      sha: await sha('New\n'),
    });
  });

  it.each([
    ['an existing file', 'README.md', { code: 'path_exists', details: { path: 'README.md' } }],
    ['an existing directory', 'content', { code: 'path_exists', details: { path: 'content' } }],
    ['a submodule', 'vendor/lib', { code: 'path_exists', details: { path: 'vendor/lib' } }],
    [
      'a path beneath a file',
      'README.md/x',
      { code: 'path_conflict', details: { path: 'README.md/x', conflictingPath: 'README.md' } },
    ],
  ])('fails on %s', async (_, path, expected) => {
    expect(await errorOf([{ action: 'create', path, content: 'x' }])).toEqual(expected);
  });
});

describe('update', () => {
  it('replaces content and keeps the executable bit', async () => {
    const files = await apply([
      { action: 'update', path: 'scripts/build.sh', content: '#!/bin/sh\nexit 0\n' },
    ]);
    expect(files.get('scripts/build.sh')).toMatchObject({
      mode: '100755',
      sha: await sha('#!/bin/sh\nexit 0\n'),
    });
  });

  it('keeps a symbolic link a symbolic link', async () => {
    const files = await apply([{ action: 'update', path: 'current', content: 'README.md' }]);
    expect(files.get('current')).toMatchObject({ mode: '120000', sha: await sha('README.md') });
  });

  it.each(['missing.md', 'content', 'vendor/lib', 'README.md/x'])(
    'fails with path_not_found on %s',
    async (path) => {
      expect(await errorOf([{ action: 'update', path, content: 'x' }])).toEqual({
        code: 'path_not_found',
        details: { path },
      });
    },
  );
});

describe('upsert', () => {
  it('creates a missing file', async () => {
    const files = await apply([{ action: 'upsert', path: 'new.md', content: 'n' }]);
    expect(files.get('new.md')).toMatchObject({ mode: '100644', sha: await sha('n') });
  });

  it('replaces an existing file, keeping its mode', async () => {
    const files = await apply([{ action: 'upsert', path: 'scripts/build.sh', content: 'y' }]);
    expect(files.get('scripts/build.sh')).toMatchObject({ mode: '100755', sha: await sha('y') });
  });

  it.each([
    ['a directory', 'content', { code: 'path_exists', details: { path: 'content' } }],
    ['a submodule', 'vendor/lib', { code: 'path_exists', details: { path: 'vendor/lib' } }],
    [
      'a path beneath a file',
      'README.md/x',
      { code: 'path_conflict', details: { path: 'README.md/x', conflictingPath: 'README.md' } },
    ],
  ])('fails on %s', async (_, path, expected) => {
    expect(await errorOf([{ action: 'upsert', path, content: 'x' }])).toEqual(expected);
  });
});

describe('delete', () => {
  it('deletes a file and the directories it leaves empty', async () => {
    const files = await apply([{ action: 'delete', path: 'content/blog/one.md' }]);
    expect(files.has('content/blog/one.md')).toBe(false);
    expect(files.has('content/about.md')).toBe(true);
  });

  it('deletes a symbolic link', async () => {
    expect((await apply([{ action: 'delete', path: 'current' }])).has('current')).toBe(false);
  });

  it.each(['missing.md', 'content', 'vendor/lib'])('fails with path_not_found on %s', async (path) => {
    expect(await errorOf([{ action: 'delete', path }])).toEqual({
      code: 'path_not_found',
      details: { path },
    });
  });
});
