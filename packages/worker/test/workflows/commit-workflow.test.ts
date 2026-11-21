// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { CommitWorkflowParams } from '../../src/workflows/commit-workflow-schemas.ts';
import { COMMIT_STEP_CONFIG, runCommitWorkflow } from '../../src/workflows/run-commit-workflow.ts';
import { BranchMovedError } from '../../src/workflows/step-errors.ts';
import {
  FakeStepRunner,
  FakeWorkflowStarter,
  FatalStepError,
  markFatal,
  SimulatedCrash,
} from '../helpers/fake-workflow.ts';
import {
  AUTHOR,
  isPush,
  key,
  memoryGateway,
  messages,
  racingFetch,
  seed,
  write,
} from '../helpers/memory-gateway.ts';

const REPO = 'commit-workflow';

const params = (idempotencyKey: string, content = 'from the workflow\n') =>
  CommitWorkflowParams.parse({
    repo: REPO,
    branch: 'main',
    message: 'Workflow write',
    author: AUTHOR,
    idempotencyKey,
    actions: [{ action: 'upsert', path: 'workflow.md', content }],
  });

async function seeded() {
  const backend = new MemoryBackend();
  const fixture = memoryGateway({}, backend);
  await seed(fixture.gateway, REPO);
  return fixture;
}

async function commitsWithKey(gateway: Parameters<typeof messages>[0], idempotencyKey: string) {
  return (await messages(gateway, REPO, 'main')).filter((text) => text.includes(idempotencyKey)).length;
}

describe('CommitWorkflow', () => {
  it('finishes a commit the RPC call handed off, with the same idempotency key', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO);
    const starter = new FakeWorkflowStarter<CommitWorkflowParams>();
    const fetch = racingFetch(
      backend,
      2,
      async (index) => void (await write(rival, REPO, 'main', { [`r${index}`]: 'r' })),
    );
    const queuing = memoryGateway({ fetch, commitWorkflow: starter, config: { inlineRetries: 1 } }, backend);
    const idempotencyKey = key('queued');
    const queued = await queuing.gateway.commit(params(idempotencyKey));
    if (queued.status !== 'queued') throw new Error(`expected queued, got ${queued.status}`);

    const payload = starter.instances.get(queued.workflowInstanceId);
    const { context } = memoryGateway({}, backend);
    const result = await runCommitWorkflow(context, payload, new FakeStepRunner(), markFatal);

    expect(result).toEqual({
      status: 'committed',
      sha: (await rival.resolveRef({ repo: REPO, ref: 'main' }))?.sha,
    });
    expect(await commitsWithKey(rival, idempotencyKey)).toBe(1);
  });

  it('replays a step that crashed after its push into exactly one commit', async () => {
    const { gateway, context } = await seeded();
    const runner = new FakeStepRunner();
    runner.crashAfterNextRun('commit');
    const idempotencyKey = key('crash');
    await expect(
      runCommitWorkflow(context, params(idempotencyKey), runner, markFatal),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    const pushed = (await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha;
    expect(await commitsWithKey(gateway, idempotencyKey)).toBe(1);

    const replayed = await runCommitWorkflow(context, params(idempotencyKey), runner, markFatal);
    expect(replayed).toEqual({ status: 'replayed', sha: pushed });
    expect(runner.runs.get('commit')).toBe(2);
    expect(await commitsWithKey(gateway, idempotencyKey)).toBe(1);
    // A third replay is answered from the stored result without running the step again.
    expect(await runCommitWorkflow(context, params(idempotencyKey), runner, markFatal)).toEqual(replayed);
    expect(runner.runs.get('commit')).toBe(2);
  });

  it('retries the step while the branch keeps moving, then commits once', async () => {
    const backend = new MemoryBackend();
    const rival = memoryGateway({}, backend).gateway;
    await seed(rival, REPO);
    const fetch = racingFetch(
      backend,
      2,
      async (index) => void (await write(rival, REPO, 'main', { [`r${index}`]: 'r' })),
    );
    const { context } = memoryGateway({ fetch }, backend);
    const runner = new FakeStepRunner();
    const idempotencyKey = key('moving');
    const result = await runCommitWorkflow(context, params(idempotencyKey), runner, markFatal);
    expect(result.status).toBe('committed');
    expect(runner.runs.get('commit')).toBe(3);
    expect(await commitsWithKey(rival, idempotencyKey)).toBe(1);
  });

  it('retries storage failures rather than stopping', async () => {
    const backend = new MemoryBackend();
    await seed(memoryGateway({}, backend).gateway, REPO);
    let failures = 2;
    const fetch = async (request: Request): Promise<Response> => {
      if (isPush(request) && failures > 0) {
        failures -= 1;
        return new Response('unavailable', { status: 503 });
      }
      return backend.fetch(request);
    };
    const runner = new FakeStepRunner();
    const result = await runCommitWorkflow(
      memoryGateway({ fetch }, backend).context,
      params(key()),
      runner,
      markFatal,
    );
    expect(result.status).toBe('committed');
    expect(runner.runs.get('commit')).toBe(3);
  });

  it('stops at once when the actions break a rule, keeping the GatewayError body', async () => {
    const { context } = await seeded();
    const runner = new FakeStepRunner();
    const broken = { ...params(key()), actions: [{ action: 'delete' as const, path: 'missing.md' }] };
    const error: unknown = await runCommitWorkflow(context, broken, runner, markFatal).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FatalStepError);
    expect(readGatewayError(error)).toMatchObject({
      code: 'path_not_found',
      details: { path: 'missing.md' },
    });
    expect(runner.runs.get('commit')).toBe(1);
  });

  it('stops before any step when the params are not a commit input', async () => {
    const { context } = await seeded();
    const runner = new FakeStepRunner();
    const error: unknown = await runCommitWorkflow(context, { repo: REPO }, runner, markFatal).catch(
      (thrown: unknown) => thrown,
    );
    expect(readGatewayError(error)?.code).toBe('invalid_input');
    expect(runner.runs.size).toBe(0);
  });

  it('reports a commit that changes nothing as noop', async () => {
    const { gateway, context } = await seeded();
    const head = (await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha;
    const same = {
      ...params(key()),
      actions: [{ action: 'update' as const, path: 'README.md', content: '# Seed\n' }],
    };
    expect(await runCommitWorkflow(context, same, new FakeStepRunner(), markFatal)).toEqual({
      status: 'noop',
      head,
    });
  });

  it('throws the plain error when no fatal mapping is given', async () => {
    const { context } = await seeded();
    const broken = { ...params(key()), actions: [{ action: 'delete' as const, path: 'missing.md' }] };
    const error: unknown = await runCommitWorkflow(context, broken, new FakeStepRunner()).catch(
      (thrown: unknown) => thrown,
    );
    expect(readGatewayError(error)?.code).toBe('path_not_found');
  });

  it('declares bounded retries with backoff and a timeout on its step', async () => {
    const { context } = await seeded();
    const runner = new FakeStepRunner();
    await runCommitWorkflow(context, params(key()), runner, markFatal);
    expect(runner.configs.get('commit')).toEqual(COMMIT_STEP_CONFIG);
    expect(COMMIT_STEP_CONFIG.retries.backoff).toBe('exponential');
  });

  it('signals a moved branch with a retryable error that is not a gateway error', () => {
    const error = new BranchMovedError('main');
    expect(error.name).toBe('BranchMovedError');
    expect(readGatewayError(error)).toBeNull();
  });
});
