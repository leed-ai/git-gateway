// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { pushRefUpdate } from '../../src/rpc/push-ref.ts';
import { memoryGateway, racingFetch, seed, write } from '../helpers/memory-gateway.ts';
import { refusingFetch } from '../helpers/refusing-fetch.ts';

const REPO = 'promote';

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  throw new Error('expected the call to fail');
}

/** main at a seed, staging one commit ahead of it. */
async function stagingAhead() {
  const fixture = memoryGateway();
  const main = await seed(fixture.gateway, REPO);
  const staging = await write(fixture.gateway, REPO, 'staging', { 'new.md': 'n' }, { startBranch: 'main' });
  return { ...fixture, main, staging };
}

describe('promote over git', () => {
  it('fast-forwards into to the head of from', async () => {
    const { gateway, main, staging } = await stagingAhead();
    const output = await gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging });
    expect(output).toEqual({
      status: 'promoted',
      refUpdate: { ref: 'refs/heads/main', oldSha: main, newSha: staging },
    });
    expect((await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha).toBe(staging);
  });

  it('creates into at sha when it does not exist', async () => {
    const { gateway, staging } = await stagingAhead();
    const output = await gateway.promote({ repo: REPO, from: 'staging', into: 'production', sha: staging });
    expect(output).toEqual({
      status: 'promoted',
      refUpdate: { ref: 'refs/heads/production', oldSha: ZERO_SHA, newSha: staging },
    });
  });

  it('is up_to_date when into already points at sha', async () => {
    const { gateway, staging } = await stagingAhead();
    await gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging });
    expect(await gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging })).toEqual({
      status: 'up_to_date',
      head: staging,
    });
  });

  it('refuses a sha that is not the head of from', async () => {
    const { gateway, main, staging } = await stagingAhead();
    expect(await errorOf(gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: main }))).toEqual({
      code: 'not_head_of_source',
      message: expect.any(String),
      details: { from: 'staging', sha: main, head: staging },
    });
  });

  it('refuses a sha that does not contain the head of into, and never merges', async () => {
    const { gateway, staging } = await stagingAhead();
    const mainAhead = await write(gateway, REPO, 'main', { 'hotfix.md': 'h' });
    expect(
      await errorOf(gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging })),
    ).toEqual({
      code: 'not_fast_forward',
      message: expect.any(String),
      details: { into: 'main', sha: staging, head: mainAhead },
    });
    expect((await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha).toBe(mainAhead);
  });

  it('refuses to move into backwards when into is already ahead of sha', async () => {
    const { gateway, staging } = await stagingAhead();
    await gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging });
    const mainAhead = await write(gateway, REPO, 'main', { 'after.md': 'a' });
    expect(
      await errorOf(gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging })),
    ).toMatchObject({ code: 'not_fast_forward', details: { into: 'main', sha: staging, head: mainAhead } });
    expect((await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha).toBe(mainAhead);
  });

  it('refuses a missing source branch with ref_not_found', async () => {
    const { gateway, staging } = await stagingAhead();
    expect(
      await errorOf(gateway.promote({ repo: REPO, from: 'nope', into: 'main', sha: staging })),
    ).toMatchObject({
      code: 'ref_not_found',
      details: { ref: 'nope' },
    });
  });

  it('re-checks after into moves under it, refusing the now non-fast-forward promotion', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO);
    const staging = await write(rival, REPO, 'staging', { 'new.md': 'n' }, { startBranch: 'main' });
    const fetch = racingFetch(
      backend,
      1,
      async () => void (await write(rival, REPO, 'main', { 'race.md': 'r' })),
    );
    const { gateway } = memoryGateway({ fetch }, backend);
    const error = await errorOf(gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging }));
    expect(error?.code).toBe('not_fast_forward');
    expect(fetch.pushes()).toBe(1);
  });

  it('promotes after into moved forward along the promoted history', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    const main = await seed(rival, REPO);
    const middle = await write(rival, REPO, 'staging', { 'one.md': '1' }, { startBranch: 'main' });
    const staging = await write(rival, REPO, 'staging', { 'two.md': '2' });
    const fetch = racingFetch(backend, 1, async () => {
      await rival.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging });
    });
    const { gateway } = memoryGateway({ fetch }, backend);
    // The rival promotes first, so the gateway's retry finds main already at sha.
    const output = await gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging });
    expect(output).toEqual({ status: 'up_to_date', head: staging });
    expect([main, middle]).not.toContain(staging);
  });

  it('reports storage_unavailable when the host refuses the update for another reason', async () => {
    const backend = new MemoryBackend();
    const { gateway } = memoryGateway({}, backend);
    await seed(gateway, REPO);
    const staging = await write(gateway, REPO, 'staging', { 'n.md': 'n' }, { startBranch: 'main' });
    const fetch = refusingFetch(backend.fetch, {
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/main', status: 'ng', reason: 'protected branch' }],
    });
    const refusing = memoryGateway({ fetch }, backend).gateway;
    const error = await errorOf(
      refusing.promote({ repo: REPO, from: 'staging', into: 'main', sha: staging }),
    );
    expect(error).toMatchObject({ code: 'storage_unavailable' });
  });

  it('gives up with stale_head when into keeps being moved along the promoted history', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend);
    await seed(rival.gateway, REPO);
    const steps = [await write(rival.gateway, REPO, 'staging', { 'a.md': 'a' }, { startBranch: 'main' })];
    steps.push(await write(rival.gateway, REPO, 'staging', { 'b.md': 'b' }));
    const head = await write(rival.gateway, REPO, 'staging', { 'c.md': 'c' });
    // Before each push, main moves one staging commit forward: still a fast-forward towards head.
    const fetch = racingFetch(backend, 2, async (index) => {
      const current = await backend.resolveRef(REPO, 'refs/heads/main');
      const next = steps[index - 1] ?? head;
      await pushRefUpdate(
        rival.context,
        REPO,
        { ref: 'refs/heads/main', oldSha: current ?? ZERO_SHA, newSha: next },
        [],
      );
    });
    const { gateway } = memoryGateway({ fetch, config: { inlineRetries: 1 } }, backend);
    const error = await errorOf(gateway.promote({ repo: REPO, from: 'staging', into: 'main', sha: head }));
    expect(error).toMatchObject({
      code: 'stale_head',
      details: { branch: 'main', expectedHead: steps[0], actualHead: steps[1] },
    });
  });
});
