// SPDX-License-Identifier: Apache-2.0
import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { createCommitWorkflow } from '../../src/workflows/commit-workflow.ts';
import { createSyncBranchWorkflow } from '../../src/workflows/sync-branch-workflow.ts';
import { nonRetryable, stepRunnerOf } from '../../src/workflows/workflow-runtime.ts';
import { AUTHOR, memoryGateway, SECRET, seed, write } from '../helpers/memory-gateway.ts';

interface TestEnv {
  readonly backend: MemoryBackend;
}

const options = (env: TestEnv) => ({
  backend: env.backend,
  readTokenSecret: SECRET,
  fetch: env.backend.fetch,
});

/**
 * A stand-in for the engine's WorkflowStep that runs each step once and keeps its result. The
 * callback is found among the arguments as the engine's overloads place it.
 */
class OnceStep implements WorkflowStep {
  readonly results = new Map<string, unknown>();
  readonly sleep = async (): Promise<void> => undefined;
  readonly sleepUntil = async (): Promise<void> => undefined;
  readonly waitForEvent = async (): Promise<never> => Promise.reject(new Error('no events in this test'));

  async do<T>(name: string, ...rest: unknown[]): Promise<T> {
    const callback = rest.find((value) => typeof value === 'function');
    if (typeof callback !== 'function') throw new Error('step without a callback');
    const result: T = await Reflect.apply(callback, undefined, []);
    this.results.set(name, result);
    return result;
  }
}

/**
 * Calls a workflow class's `run` as the engine would, with `env` bound. (Only the engine can
 * construct a WorkflowEntrypoint, so the method runs against a stand-in instance.)
 */
async function run(
  workflow: { prototype: { run: unknown } },
  env: TestEnv,
  payload: unknown,
  step: WorkflowStep,
): Promise<unknown> {
  const method = workflow.prototype.run;
  if (typeof method !== 'function') throw new Error('workflow without run()');
  return Reflect.apply(method, { env }, [payload, step]);
}

const event = <T>(payload: T) => ({
  payload,
  timestamp: new Date(),
  instanceId: 'test-instance',
  workflowName: 'test',
});

describe('Workflow classes', () => {
  it('CommitWorkflow is a WorkflowEntrypoint that commits through the configured backend', async () => {
    const backend = new MemoryBackend();
    const { gateway } = memoryGateway({}, backend);
    await seed(gateway, 'classes');
    const CommitWorkflow = createCommitWorkflow(options);
    expect(CommitWorkflow.prototype).toBeInstanceOf(WorkflowEntrypoint);
    const step = new OnceStep();
    const payload = {
      repo: 'classes',
      branch: 'main',
      message: 'From the class',
      author: AUTHOR,
      idempotencyKey: 'class-1',
      actions: [{ action: 'create' as const, path: 'c.md', content: 'c', encoding: 'text' as const }],
    };
    const result: unknown = await run(CommitWorkflow, { backend }, event(payload), step);
    expect(result).toEqual({
      status: 'committed',
      sha: (await gateway.resolveRef({ repo: 'classes', ref: 'main' }))?.sha,
    });
    expect(step.results.get('commit')).toEqual(result);
  });

  it('CommitWorkflow stops a broken commit with a NonRetryableError carrying the GatewayError', async () => {
    const backend = new MemoryBackend();
    await seed(memoryGateway({}, backend).gateway, 'classes');
    const payload = {
      repo: 'classes',
      branch: 'main',
      message: 'Broken',
      author: AUTHOR,
      idempotencyKey: 'class-2',
      actions: [{ action: 'delete' as const, path: 'missing.md' }],
    };
    const error: unknown = await run(
      createCommitWorkflow(options),
      { backend },
      event(payload),
      new OnceStep(),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(readGatewayError(error)?.code).toBe('path_not_found');
  });

  it('SyncBranchWorkflow is a WorkflowEntrypoint that syncs through the configured backend', async () => {
    const backend = new MemoryBackend();
    const { gateway } = memoryGateway({}, backend);
    await seed(gateway, 'classes');
    await write(gateway, 'classes', 'staging', { 's.md': 's' }, { startBranch: 'main' });
    const main = await write(gateway, 'classes', 'main', { 'm.md': 'm' });
    const SyncBranchWorkflow = createSyncBranchWorkflow(options);
    expect(SyncBranchWorkflow.prototype).toBeInstanceOf(WorkflowEntrypoint);
    const payload = { repo: 'classes', from: 'main', into: 'staging', fromHead: main };
    const result: unknown = await run(SyncBranchWorkflow, { backend }, event(payload), new OnceStep());
    expect(result).toMatchObject({ status: 'merged' });
  });

  it('adapts a WorkflowStep and maps fatal errors to NonRetryableError keeping the message', async () => {
    const step = new OnceStep();
    const runner = stepRunnerOf(step);
    expect(
      await runner.do(
        's',
        { retries: { limit: 1, delay: '1 second', backoff: 'constant' }, timeout: '1 minute' },
        async () => ({ status: 'noop', head: null }),
      ),
    ).toEqual({ status: 'noop', head: null });
    const fatal = nonRetryable(new Error('GatewayError {"code":"x"}'));
    expect(fatal).toBeInstanceOf(NonRetryableError);
    expect(fatal.message).toBe('GatewayError {"code":"x"}');
  });
});
