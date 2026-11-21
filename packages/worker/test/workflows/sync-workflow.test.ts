// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { runSyncWorkflow, SYNC_STEP_CONFIG } from '../../src/workflows/run-sync-workflow.ts';
import { FakeStepRunner, FatalStepError, markFatal, SimulatedCrash } from '../helpers/fake-workflow.ts';
import { memoryGateway, racingFetch, seed, write } from '../helpers/memory-gateway.ts';

const REPO = 'sync-workflow';
const SYNC = { repo: REPO, from: 'main', into: 'staging' };

/** main and staging diverged from a seed; returns the fixture and both heads. */
async function diverged(onMain: Record<string, string>, onStaging: Record<string, string>) {
  const fixture = memoryGateway();
  await seed(fixture.gateway, REPO, { 'shared.md': 'base\n' });
  const staging = await write(fixture.gateway, REPO, 'staging', onStaging, { startBranch: 'main' });
  const main = await write(fixture.gateway, REPO, 'main', onMain);
  return { ...fixture, main, staging };
}

const params = (fromHead: string) => ({ ...SYNC, fromHead });

describe('SyncBranchWorkflow', () => {
  it('merges from into into and stores the merge commit id', async () => {
    const { gateway, context, main, staging } = await diverged({ 'a.md': 'a' }, { 'b.md': 'b' });
    const result = await runSyncWorkflow(context, params(main), new FakeStepRunner(), markFatal);
    const head = (await gateway.resolveRef({ repo: REPO, ref: 'staging' }))?.sha;
    expect(result).toEqual({ status: 'merged', head });
    const log = await gateway.log({ repo: REPO, ref: 'staging', limit: 1 });
    expect(log.commits[0]?.parents).toEqual([staging, main]);
  });

  it('fast-forwards and reports up_to_date in the other two shapes', async () => {
    const { gateway, context } = memoryGateway();
    const seedHead = await seed(gateway, REPO);
    await gateway.promote({ repo: REPO, from: 'main', into: 'staging', sha: seedHead });
    const ahead = await write(gateway, REPO, 'main', { 'n.md': 'n' });
    expect(await runSyncWorkflow(context, params(ahead), new FakeStepRunner(), markFatal)).toEqual({
      status: 'fast_forward',
      head: ahead,
    });
    expect(await runSyncWorkflow(context, params(ahead), new FakeStepRunner(), markFatal)).toEqual({
      status: 'up_to_date',
      head: ahead,
    });
  });

  it('replays a step that crashed after merging as up_to_date: one merge commit only', async () => {
    const { gateway, context, main } = await diverged({ 'a.md': 'a' }, { 'b.md': 'b' });
    const runner = new FakeStepRunner();
    runner.crashAfterNextRun('sync');
    await expect(runSyncWorkflow(context, params(main), runner, markFatal)).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    const merged = (await gateway.resolveRef({ repo: REPO, ref: 'staging' }))?.sha;
    expect(await runSyncWorkflow(context, params(main), runner, markFatal)).toEqual({
      status: 'up_to_date',
      head: merged,
    });
    const log = await gateway.log({ repo: REPO, ref: 'staging', limit: 10 });
    expect(log.commits.filter((commit) => commit.parents.length === 2)).toHaveLength(1);
  });

  it('completes with the conflicting paths when the branches conflict', async () => {
    const { context, main, staging } = await diverged(
      { 'shared.md': 'main\n' },
      { 'shared.md': 'staging\n' },
    );
    const result = await runSyncWorkflow(context, params(main), new FakeStepRunner(), markFatal);
    expect(result).toMatchObject({
      status: 'conflict',
      paths: ['shared.md'],
      fromHead: main,
      intoHead: staging,
    });
  });

  it('retries while into keeps moving, then merges', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO, { 'shared.md': 'base\n' });
    await write(rival, REPO, 'staging', { 'b.md': 'b' }, { startBranch: 'main' });
    const main = await write(rival, REPO, 'main', { 'a.md': 'a' });
    const fetch = racingFetch(
      backend,
      1,
      async () => void (await write(rival, REPO, 'staging', { 'c.md': 'c' })),
    );
    const runner = new FakeStepRunner();
    const result = await runSyncWorkflow(
      memoryGateway({ fetch }, backend).context,
      params(main),
      runner,
      markFatal,
    );
    expect(result.status).toBe('merged');
    expect(runner.runs.get('sync')).toBe(2);
    expect(await rival.readFile({ repo: REPO, ref: 'staging', path: 'c.md' })).not.toBeNull();
  });

  it('stops at once when a branch is missing', async () => {
    const { gateway, context } = memoryGateway();
    const head = await seed(gateway, REPO);
    const runner = new FakeStepRunner();
    const error: unknown = await runSyncWorkflow(context, params(head), runner, markFatal).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FatalStepError);
    expect(readGatewayError(error)).toMatchObject({ code: 'ref_not_found', details: { ref: 'staging' } });
    expect(runner.runs.get('sync')).toBe(1);
  });

  it('stops before any step on invalid params', async () => {
    const { context } = memoryGateway();
    const runner = new FakeStepRunner();
    const bad = { repo: REPO, from: 'main', into: 'main', fromHead: '0'.repeat(40) };
    const error: unknown = await runSyncWorkflow(context, bad, runner, markFatal).catch((e: unknown) => e);
    expect(readGatewayError(error)?.code).toBe('invalid_input');
    expect(runner.runs.size).toBe(0);
  });

  it('declares bounded retries with backoff and a timeout on its step', async () => {
    const { context, main } = await diverged({ 'a.md': 'a' }, { 'b.md': 'b' });
    const runner = new FakeStepRunner();
    await runSyncWorkflow(context, params(main), runner);
    expect(runner.configs.get('sync')).toEqual(SYNC_STEP_CONFIG);
  });
});
