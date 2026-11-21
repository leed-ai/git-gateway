// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { buildCommit } from '@leed-ai/git-gateway-core/commit/build-commit';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import type { GatewayContext } from '../../src/rpc/gateway-context.ts';
import { pushRefUpdate } from '../../src/rpc/push-ref.ts';
import { treeReader } from '../../src/rpc/repo-access.ts';
import type { PushEvent } from '../../src/workflows/push-event.ts';
import { AUTHOR, memoryGateway, racingFetch, seed, write } from '../helpers/memory-gateway.ts';

const REPO = 'sync';
const SYNC = { repo: REPO, from: 'main', into: 'staging' };

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  throw new Error('expected the call to fail');
}

/** Pushes a root commit to a new branch, giving it a history unrelated to every other branch. */
async function pushOrphan(context: GatewayContext, branch: string): Promise<void> {
  const built = await buildCommit(
    {
      branch,
      base: null,
      actions: [{ action: 'create', path: 'orphan.md', content: 'orphan' }],
      message: 'Orphan',
      author: AUTHOR,
      idempotencyKey: 'orphan',
      date: new Date().toISOString(),
    },
    treeReader(context, REPO),
  );
  if (built.status !== 'ready') throw new Error('expected a commit');
  await pushRefUpdate(context, REPO, built.refUpdate, built.objects);
}

describe('syncBranch over git', () => {
  it('is up_to_date when into contains from', async () => {
    const { gateway } = memoryGateway();
    await seed(gateway, REPO);
    const staging = await write(gateway, REPO, 'staging', { 'n.md': 'n' }, { startBranch: 'main' });
    expect(await gateway.syncBranch(SYNC)).toEqual({ status: 'up_to_date', head: staging });
  });

  it('fast-forwards into when it has no commits of its own, pushing no objects', async () => {
    const events: PushEvent[] = [];
    const { gateway } = memoryGateway({ onPush: async (event) => void events.push(event) });
    const seedHead = await seed(gateway, REPO);
    await gateway.promote({ repo: REPO, from: 'main', into: 'staging', sha: seedHead });
    const ahead = await write(gateway, REPO, 'main', { 'n.md': 'n' });
    const refUpdate = { ref: 'refs/heads/staging', oldSha: seedHead, newSha: ahead };
    expect(await gateway.syncBranch(SYNC)).toEqual({ status: 'fast_forward', refUpdate });
    expect(events.at(-1)?.updates).toEqual([refUpdate]);
  });

  it('writes a real git merge commit: parents into then from, file-level merge', async () => {
    const { gateway, backend } = memoryGateway();
    await seed(gateway, REPO, { 'shared.md': 'base\n', 'deep/dir/keep.md': 'keep\n' });
    const staging = await write(gateway, REPO, 'staging', { 'deep/dir/s.md': 's' }, { startBranch: 'main' });
    const main = await write(gateway, REPO, 'main', { 'deep/dir/m.md': 'm', 'shared.md': null });
    const output = await gateway.syncBranch({ ...SYNC, message: 'Sync main\n\n' });
    if (output.status !== 'merged') throw new Error(`expected merged, got ${output.status}`);
    expect(output.commit.parents).toEqual([staging, main]);
    expect(output.commit.message).toBe('Sync main\n');
    expect(await backend.readCommit(REPO, output.commit.sha)).toEqual(output.commit);
    const listing = await gateway.listTree({ repo: REPO, ref: 'staging', recursive: true });
    expect(listing?.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path)).toEqual([
      'deep/dir/keep.md',
      'deep/dir/m.md',
      'deep/dir/s.md',
    ]);
  });

  it('merges as the configured service identity when no author is given', async () => {
    const serviceIdentity = { name: 'Sync Service', email: 'sync@example.com' };
    const { gateway } = memoryGateway({ config: { serviceIdentity } });
    await seed(gateway, REPO);
    await write(gateway, REPO, 'staging', { 's.md': 's' }, { startBranch: 'main' });
    await write(gateway, REPO, 'main', { 'm.md': 'm' });
    const output = await gateway.syncBranch(SYNC);
    if (output.status !== 'merged') throw new Error('expected merged');
    expect([output.commit.author.name, output.commit.committer.email]).toEqual([
      'Sync Service',
      'sync@example.com',
    ]);
    expect(output.commit.message).toBe("Merge branch 'main' into staging\n");
  });

  it('reports a conflict with every path and the merge base, writing nothing', async () => {
    const { gateway } = memoryGateway();
    const base = await seed(gateway, REPO, { 'a.md': 'base', 'b.md': 'base' });
    const staging = await write(
      gateway,
      REPO,
      'staging',
      { 'a.md': 's', 'b.md': 's' },
      { startBranch: 'main' },
    );
    const main = await write(gateway, REPO, 'main', { 'a.md': 'm', 'b.md': null });
    expect(await gateway.syncBranch(SYNC)).toEqual({
      status: 'conflict',
      paths: ['a.md', 'b.md'],
      base,
      fromHead: main,
      intoHead: staging,
    });
    expect((await gateway.resolveRef({ repo: REPO, ref: 'staging' }))?.sha).toBe(staging);
  });

  it('merges on top of a commit that landed on into during the sync', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO);
    await write(rival, REPO, 'staging', { 's.md': 's' }, { startBranch: 'main' });
    await write(rival, REPO, 'main', { 'm.md': 'm' });
    let landed = '';
    const fetch = racingFetch(backend, 1, async () => {
      landed = await write(rival, REPO, 'staging', { 'late.md': 'late' });
    });
    const output = await memoryGateway({ fetch }, backend).gateway.syncBranch(SYNC);
    if (output.status !== 'merged') throw new Error('expected merged');
    expect(output.commit.parents[0]).toBe(landed);
  });

  it('gives up with stale_head when into moves under every attempt', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO);
    await write(rival, REPO, 'staging', { 's.md': 's' }, { startBranch: 'main' });
    await write(rival, REPO, 'main', { 'm.md': 'm' });
    const fetch = racingFetch(
      backend,
      2,
      async (index) => void (await write(rival, REPO, 'staging', { [`x${index}`]: 'x' })),
    );
    const error = await errorOf(
      memoryGateway({ fetch, config: { inlineRetries: 1 } }, backend).gateway.syncBranch(SYNC),
    );
    expect(error).toMatchObject({ code: 'stale_head', details: { branch: 'staging' } });
  });

  it('refuses unrelated histories', async () => {
    const { gateway, context } = memoryGateway();
    await seed(gateway, REPO);
    await pushOrphan(context, 'staging');
    expect(await errorOf(gateway.syncBranch(SYNC))).toMatchObject({
      code: 'unrelated_histories',
      details: { from: 'main', into: 'staging' },
    });
  });

  it('never creates into: a missing branch is ref_not_found', async () => {
    const { gateway } = memoryGateway();
    await seed(gateway, REPO);
    expect(await errorOf(gateway.syncBranch(SYNC))).toMatchObject({ code: 'ref_not_found' });
    expect(await gateway.resolveRef({ repo: REPO, ref: 'staging' })).toBeNull();
  });

  it('pushes with the head it built on, so creation from zero never happens', async () => {
    const events: PushEvent[] = [];
    const { gateway } = memoryGateway({ onPush: async (event) => void events.push(event) });
    await seed(gateway, REPO);
    await write(gateway, REPO, 'staging', { 's.md': 's' }, { startBranch: 'main' });
    await write(gateway, REPO, 'main', { 'm.md': 'm' });
    await gateway.syncBranch(SYNC);
    const syncUpdate = events.at(-1)?.updates[0];
    expect(syncUpdate?.ref).toBe('refs/heads/staging');
    expect(syncUpdate?.oldSha).not.toBe(ZERO_SHA);
  });
});
