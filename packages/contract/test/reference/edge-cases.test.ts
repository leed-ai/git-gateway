// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import type { CommitActionInput } from '../../src/schemas/commit-action.ts';
import { AUTHOR, codeOf, commit, key, seeded } from './edge-fixtures.ts';

// Edge cases of the reference commit() beyond the behaviour suite: the less common corners of the
// commit-action table, no-op detection across encodings and modes, and idempotency scope.

describe('commit-action table: less common failures', () => {
  it.each<[string, CommitActionInput, string]>([
    ['upsert beneath a file', { action: 'upsert', path: 'top.txt/x', content: 'x' }, 'path_conflict'],
    ['move onto a directory', { action: 'move', path: 'docs', previousPath: 'top.txt' }, 'path_exists'],
    [
      'move beneath a file',
      { action: 'move', path: 'top.txt/x', previousPath: 'docs/a.md' },
      'path_conflict',
    ],
    ['delete of a directory', { action: 'delete', path: 'docs' }, 'path_not_found'],
    ['chmod of a directory', { action: 'chmod', path: 'docs', executeFilemode: true }, 'path_not_found'],
    ['move of a directory', { action: 'move', path: 'd2', previousPath: 'docs' }, 'path_not_found'],
  ])('%s is refused', async (_name, action, code) => {
    const gateway = await seeded();
    const before = await gateway.resolveRef({ repo: 'r', ref: 'main' });
    expect(await codeOf(commit(gateway, [action]))).toBe(code);
    expect(await gateway.resolveRef({ repo: 'r', ref: 'main' })).toEqual(before);
  });

  it('a path freed earlier in the same commit can be created again', async () => {
    const gateway = await seeded();
    const output = await commit(gateway, [
      { action: 'delete', path: 'top.txt' },
      { action: 'create', path: 'top.txt/inner.md', content: 'now a directory\n' },
    ]);
    expect(output.status).toBe('committed');
    const listing = await gateway.listTree({ repo: 'r', ref: 'main' });
    expect(listing?.entries.find((entry) => entry.path === 'top.txt')?.type).toBe('tree');
  });

  it('a later action sees a file created by an earlier one', async () => {
    const gateway = await seeded();
    expect(
      await codeOf(
        commit(gateway, [
          { action: 'create', path: 'new.md', content: '1' },
          { action: 'create', path: 'new.md', content: '2' },
        ]),
      ),
    ).toBe('path_exists');
  });
});

describe('no-op detection', () => {
  it.each<[string, CommitActionInput[]]>([
    ['update with identical text', [{ action: 'update', path: 'docs/a.md', content: 'a\n' }]],
    [
      'update with the same bytes as base64',
      [{ action: 'update', path: 'docs/a.md', content: btoa('a\n'), encoding: 'base64' }],
    ],
    ['upsert with identical content', [{ action: 'upsert', path: 'top.txt', content: 'top\n' }]],
    ['chmod to the mode the file has', [{ action: 'chmod', path: 'docs/a.md', executeFilemode: false }]],
    [
      'create then delete in one commit',
      [
        { action: 'create', path: 'tmp.md', content: 'x' },
        { action: 'delete', path: 'tmp.md' },
      ],
    ],
    [
      'move away and back',
      [
        { action: 'move', path: 'b.md', previousPath: 'docs/a.md' },
        { action: 'move', path: 'docs/a.md', previousPath: 'b.md' },
      ],
    ],
  ])('%s is a noop that keeps the head', async (_name, actions) => {
    const gateway = await seeded();
    const head = await gateway.resolveRef({ repo: 'r', ref: 'main' });
    const output = await commit(gateway, actions);
    expect(output).toEqual({ status: 'noop', head: head?.sha });
    expect(await gateway.resolveRef({ repo: 'r', ref: 'main' })).toEqual(head);
  });

  it('a mode-only change is not a noop', async () => {
    const gateway = await seeded();
    const output = await commit(gateway, [{ action: 'chmod', path: 'docs/a.md', executeFilemode: true }]);
    expect(output.status).toBe('committed');
    expect((await gateway.readFile({ repo: 'r', ref: 'main', path: 'docs/a.md' }))?.executable).toBe(true);
  });

  it('a noop never records the idempotency key, so a later real change with it commits', async () => {
    const gateway = await seeded();
    const base = { repo: 'r', branch: 'main', author: AUTHOR, message: 'm', idempotencyKey: 'same' };
    const noop = await gateway.commit({
      ...base,
      actions: [{ action: 'update', path: 'docs/a.md', content: 'a\n' }],
    });
    expect(noop.status).toBe('noop');
    const real = await gateway.commit({
      ...base,
      actions: [{ action: 'update', path: 'docs/a.md', content: 'A\n' }],
    });
    expect(real.status).toBe('committed');
  });

  it('a noop on a missing branch reports a null head and creates no branch', async () => {
    const gateway = await seeded();
    const output = await gateway.commit({
      repo: 'r',
      branch: 'feature',
      startBranch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: key(),
      actions: [{ action: 'upsert', path: 'top.txt', content: 'top\n' }],
    });
    expect(output).toEqual({ status: 'noop', head: null });
    expect(await gateway.resolveRef({ repo: 'r', ref: 'feature' })).toBeNull();
  });
});

describe('idempotency', () => {
  it('a key used on one branch does not replay on another', async () => {
    const gateway = await seeded();
    await gateway.commit({
      repo: 'r',
      branch: 'staging',
      startBranch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: 'shared',
      actions: [{ action: 'create', path: 's.md', content: 's' }],
    });
    const onMain = await gateway.commit({
      repo: 'r',
      branch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: 'shared',
      actions: [{ action: 'create', path: 'm.md', content: 'm' }],
    });
    expect(onMain.status).toBe('committed');
  });

  it('a replay ignores the new actions entirely, even ones that would fail', async () => {
    const gateway = await seeded();
    const base = { repo: 'r', branch: 'main', author: AUTHOR, message: 'm', idempotencyKey: 'k' };
    const first = await gateway.commit({
      ...base,
      actions: [{ action: 'create', path: 'k.md', content: 'k' }],
    });
    const retry = await gateway.commit({ ...base, actions: [{ action: 'delete', path: 'missing.md' }] });
    expect(retry.status).toBe('replayed');
    expect(retry.status === 'replayed' && first.status === 'committed' ? retry.commit.sha : null).toBe(
      first.status === 'committed' ? first.commit.sha : undefined,
    );
  });
});
