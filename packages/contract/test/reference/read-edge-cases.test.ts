// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { steppingClock } from '../../src/reference/clock.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';
import { AUTHOR, codeOf, commit, key, seeded } from './edge-fixtures.ts';

// Edge cases of the reference reads, lifecycle, promote and sync beyond the behaviour suite: read
// encodings, log paging with since, repository isolation and promote ordering.

describe('reads', () => {
  it('readFile with encoding base64 always returns base64', async () => {
    const gateway = await seeded();
    const file = await gateway.readFile({ repo: 'r', ref: 'main', path: 'docs/a.md', encoding: 'base64' });
    expect(file).toMatchObject({ encoding: 'base64', content: btoa('a\n'), size: 2 });
  });

  it('readFile with encoding text falls back to base64 for bytes that are not UTF-8', async () => {
    const gateway = await seeded();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const content = btoa(String.fromCharCode(...bytes));
    await commit(gateway, [{ action: 'create', path: 'blob.bin', content, encoding: 'base64' }]);
    const file = await gateway.readFile({ repo: 'r', ref: 'main', path: 'blob.bin' });
    expect(file).toMatchObject({ encoding: 'base64', content, size: 4 });
  });

  it('a sha-shaped ref that is no commit is ref_not_found, never a branch lookup', async () => {
    const gateway = await seeded();
    const ref = '0'.repeat(40);
    expect(await codeOf(gateway.readFile({ repo: 'r', ref, path: 'top.txt' }))).toBe('ref_not_found');
    expect(await codeOf(gateway.listTree({ repo: 'r', ref }))).toBe('ref_not_found');
    expect(await codeOf(gateway.log({ repo: 'r', ref }))).toBe('ref_not_found');
    expect(await gateway.resolveRef({ repo: 'r', ref })).toBeNull();
  });

  it('a path segment of 255 characters can be committed and listed back; 256 is refused', async () => {
    const gateway = await seeded();
    const name = 'x'.repeat(255);
    await commit(gateway, [{ action: 'create', path: `d/${name}`, content: 'long\n' }]);
    const listing = await gateway.listTree({ repo: 'r', ref: 'main', path: 'd' });
    expect(listing?.entries.map((entry) => entry.name)).toEqual([name]);
    const before = await gateway.resolveRef({ repo: 'r', ref: 'main' });
    expect(
      await codeOf(commit(gateway, [{ action: 'create', path: `d/${'x'.repeat(300)}`, content: 'x' }])),
    ).toBe('invalid_input');
    expect(await gateway.resolveRef({ repo: 'r', ref: 'main' })).toEqual(before);
  });

  it('a branch named like a commit id is refused, so every branch stays readable by name', async () => {
    const gateway = await seeded();
    const branch = 'a'.repeat(40);
    expect(await codeOf(commit(gateway, [{ action: 'create', path: 'x', content: 'x' }], branch))).toBe(
      'invalid_input',
    );
  });

  it('log past the end is empty with hasMore false', async () => {
    const gateway = await seeded();
    expect(await gateway.log({ repo: 'r', ref: 'main', offset: 5 })).toEqual({ commits: [], hasMore: false });
  });

  it('log combines since with limit and offset, and hasMore counts only matching commits', async () => {
    const gateway = createReferenceGateway({ now: steppingClock('2026-01-01T00:00:00.000Z', 60_000) });
    await gateway.createRepo({ repo: 'r' });
    for (let index = 0; index < 5; index += 1) {
      await commit(gateway, [{ action: 'upsert', path: 'f', content: String(index) }]);
    }
    const all = await gateway.log({ repo: 'r', ref: 'main' });
    const since = all.commits[2]?.committer.date;
    const page = await gateway.log({ repo: 'r', ref: 'main', since, limit: 2 });
    expect(page.commits.map((c) => c.sha)).toEqual(all.commits.slice(0, 2).map((c) => c.sha));
    expect(page.hasMore).toBe(true);
    const last = await gateway.log({ repo: 'r', ref: 'main', since, limit: 2, offset: 2 });
    expect(last.commits.map((c) => c.sha)).toEqual([all.commits[2]?.sha]);
    expect(last.hasMore).toBe(false);
  });

  it('commitExists is false for a commit of another repository and for a missing branch', async () => {
    const gateway = await seeded();
    await gateway.createRepo({ repo: 'other' });
    const head = await gateway.resolveRef({ repo: 'r', ref: 'main' });
    const sha = head?.sha ?? '';
    expect(await gateway.commitExists({ repo: 'other', sha })).toEqual({ exists: false });
    expect(await gateway.commitExists({ repo: 'r', sha, branch: 'nope' })).toEqual({ exists: false });
  });

  it('a newer commit is not reachable from an older branch', async () => {
    const gateway = await seeded();
    await gateway.commit({
      repo: 'r',
      branch: 'feature',
      startBranch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: key(),
      actions: [{ action: 'create', path: 'f.md', content: 'f' }],
    });
    const feature = await gateway.resolveRef({ repo: 'r', ref: 'feature' });
    const sha = feature?.sha ?? '';
    expect(await gateway.commitExists({ repo: 'r', sha })).toEqual({ exists: true });
    expect(await gateway.commitExists({ repo: 'r', sha, branch: 'main' })).toEqual({ exists: false });
  });
});

describe('repository lifecycle', () => {
  it('a repository deleted and created again starts empty', async () => {
    const gateway = await seeded();
    expect(await gateway.deleteRepo({ repo: 'r' })).toEqual({ deleted: true });
    await gateway.createRepo({ repo: 'r' });
    expect(await gateway.resolveRef({ repo: 'r', ref: 'main' })).toBeNull();
    expect(await commit(gateway, [{ action: 'create', path: 'a', content: 'a' }])).toMatchObject({
      status: 'committed',
      refUpdate: { oldSha: '0'.repeat(40) },
    });
  });

  it('repositories do not share branches or files', async () => {
    const gateway = await seeded();
    await gateway.createRepo({ repo: 'other' });
    expect(await gateway.resolveRef({ repo: 'other', ref: 'main' })).toBeNull();
    expect(await codeOf(gateway.readFile({ repo: 'other', ref: 'main', path: 'top.txt' }))).toBe(
      'ref_not_found',
    );
  });

  it('mintReadToken expires ttlSeconds after now, and differs per repository', async () => {
    const gateway = createReferenceGateway({ now: steppingClock('2026-01-01T00:00:00.000Z', 0) });
    await gateway.createRepo({ repo: 'a' });
    await gateway.createRepo({ repo: 'b' });
    const a = await gateway.mintReadToken({ repo: 'a', ttlSeconds: 900 });
    const b = await gateway.mintReadToken({ repo: 'b', ttlSeconds: 900 });
    expect(a.expiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(a.token).not.toBe(b.token);
    expect((await gateway.mintReadToken({ repo: 'a' })).expiresAt).toBe('2026-01-01T01:00:00.000Z');
  });
});

describe('promote ordering', () => {
  it('refuses a sha the target already has once the source has moved on', async () => {
    const gateway = await seeded();
    const head = (await gateway.resolveRef({ repo: 'r', ref: 'main' }))?.sha ?? '';
    await gateway.promote({ repo: 'r', from: 'main', into: 'production', sha: head });
    await commit(gateway, [{ action: 'create', path: 'later.md', content: 'later' }]);
    expect(await codeOf(gateway.promote({ repo: 'r', from: 'main', into: 'production', sha: head }))).toBe(
      'not_head_of_source',
    );
  });

  it('a refused promote leaves the target where it was', async () => {
    const gateway = await seeded();
    const head = (await gateway.resolveRef({ repo: 'r', ref: 'main' }))?.sha ?? '';
    // production branches off main and gains a commit of its own, so main's head does not contain it.
    await gateway.commit({
      repo: 'r',
      branch: 'production',
      startBranch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: key(),
      actions: [{ action: 'create', path: 'p.md', content: 'p' }],
    });
    const before = await gateway.resolveRef({ repo: 'r', ref: 'production' });
    expect(await codeOf(gateway.promote({ repo: 'r', from: 'main', into: 'production', sha: head }))).toBe(
      'not_fast_forward',
    );
    expect(await gateway.resolveRef({ repo: 'r', ref: 'production' })).toEqual(before);
  });
});

describe('sync after merge', () => {
  it('a fast-forward after a merge carries the merge commit', async () => {
    const gateway = await seeded();
    await gateway.commit({
      repo: 'r',
      branch: 'staging',
      startBranch: 'main',
      author: AUTHOR,
      message: 'm',
      idempotencyKey: key(),
      actions: [{ action: 'create', path: 's.md', content: 's' }],
    });
    await commit(gateway, [{ action: 'create', path: 'm.md', content: 'm' }]);
    const merged = await gateway.syncBranch({ repo: 'r', from: 'main', into: 'staging' });
    expect(merged.status).toBe('merged');
    const back = await gateway.syncBranch({ repo: 'r', from: 'staging', into: 'main' });
    expect(back.status).toBe('fast_forward');
    const main = await gateway.resolveRef({ repo: 'r', ref: 'main' });
    const staging = await gateway.resolveRef({ repo: 'r', ref: 'staging' });
    expect(main).toEqual(staging);
  });
});
