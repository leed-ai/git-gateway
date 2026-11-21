// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import type { CommitWorkflowParams } from '../../src/workflows/commit-workflow-schemas.ts';
import type { PushEvent } from '../../src/workflows/push-event.ts';
import { commitWorkflowId } from '../../src/workflows/workflow-instance-id.ts';
import { FakeWorkflowStarter } from '../helpers/fake-workflow.ts';
import { AUTHOR, key, memoryGateway, messages, racingFetch, seed, write } from '../helpers/memory-gateway.ts';
import { refusingFetch } from '../helpers/refusing-fetch.ts';

const REPO = 'retries';

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  throw new Error('expected the call to fail');
}

/** A backend with a seeded repository, a rival gateway on it, and a gateway whose pushes race the rival. */
async function racingSetup(races: number, options: { inlineRetries?: number; withWorkflow?: boolean } = {}) {
  const backend = new MemoryBackend();
  const rival = memoryGateway({}, backend).gateway;
  await seed(rival, REPO);
  const fetch = racingFetch(backend, races, async (index) => {
    await write(rival, REPO, 'main', { [`rival-${index}.md`]: `rival ${index}\n` });
  });
  const starter = new FakeWorkflowStarter<CommitWorkflowParams>();
  const { gateway } = memoryGateway(
    {
      fetch,
      config: { inlineRetries: options.inlineRetries ?? 2 },
      ...(options.withWorkflow === false ? {} : { commitWorkflow: starter }),
    },
    backend,
  );
  return { backend, rival, gateway, fetch, starter };
}

const input = (idempotencyKey: string) => ({
  repo: REPO,
  branch: 'main',
  message: 'Gateway write',
  author: AUTHOR,
  idempotencyKey,
  actions: [{ action: 'create' as const, path: 'gateway.md', content: 'from the gateway\n' }],
});

describe('commit: inline retries and hand-off', () => {
  it('commits on the first attempt when nothing races it', async () => {
    const { gateway, fetch, starter } = await racingSetup(0);
    const output = await gateway.commit(input(key()));
    expect(output.status).toBe('committed');
    expect(fetch.pushes()).toBe(1);
    expect(starter.creates).toBe(0);
  });

  it('rebuilds on the head that won the race and commits inline', async () => {
    const { gateway, rival, fetch } = await racingSetup(1);
    const output = await gateway.commit(input(key()));
    if (output.status !== 'committed') throw new Error(`expected committed, got ${output.status}`);
    const rivalHead = (await rival.log({ repo: REPO, ref: 'main', limit: 2 })).commits[1]?.sha;
    expect(output.commit.parents).toEqual([rivalHead]);
    expect(fetch.pushes()).toBe(2);
    expect(await rival.readFile({ repo: REPO, ref: 'main', path: 'rival-1.md' })).not.toBeNull();
  });

  it('hands the commit to a CommitWorkflow under a key-derived id when every inline attempt loses', async () => {
    const { gateway, fetch, starter } = await racingSetup(3, { inlineRetries: 2 });
    const idempotencyKey = key('handoff');
    const output = await gateway.commit(input(idempotencyKey));
    const expectedId = await commitWorkflowId(REPO, 'main', idempotencyKey);
    expect(output).toEqual({ status: 'queued', workflowInstanceId: expectedId });
    expect(fetch.pushes()).toBe(3);
    expect(starter.instances.get(expectedId)).toMatchObject({ ...input(idempotencyKey) });
    expect((await messages(gateway, REPO, 'main')).some((text) => text.includes(idempotencyKey))).toBe(false);
  });

  it('hands off after a single push when inline retries are turned off', async () => {
    const { gateway, fetch, starter } = await racingSetup(1, { inlineRetries: 0 });
    const idempotencyKey = key('no-retries');
    const output = await gateway.commit(input(idempotencyKey));
    expect(output).toEqual({
      status: 'queued',
      workflowInstanceId: await commitWorkflowId(REPO, 'main', idempotencyKey),
    });
    expect(fetch.pushes()).toBe(1);
    expect(starter.instances.size).toBe(1);
  });

  it('derives a different instance for the same key on another branch', async () => {
    const { gateway, rival, starter } = await racingSetup(6, { inlineRetries: 2 });
    await write(rival, REPO, 'staging', { 'staging.md': 's' }, { startBranch: 'main' });
    const idempotencyKey = key('per-branch');
    const onMain = await gateway.commit(input(idempotencyKey));
    const onStaging = await gateway.commit({ ...input(idempotencyKey), branch: 'staging' });
    expect(onMain.status).toBe('queued');
    expect(onStaging.status).toBe('committed');
    expect(starter.instances.size).toBe(1);
    expect(await commitWorkflowId(REPO, 'staging', idempotencyKey)).not.toBe(
      await commitWorkflowId(REPO, 'main', idempotencyKey),
    );
  });

  it('queues the same instance again when the same commit is handed off twice', async () => {
    const { gateway, starter } = await racingSetup(6, { inlineRetries: 2 });
    const idempotencyKey = key('twice');
    const first = await gateway.commit(input(idempotencyKey));
    const second = await gateway.commit(input(idempotencyKey));
    expect(second).toEqual(first);
    expect(starter.instances.size).toBe(1);
    expect(starter.creates).toBe(2);
  });

  it('restarts the instance when a retry with the same key finds it errored, so the commit is written', async () => {
    const { gateway, starter } = await racingSetup(6, { inlineRetries: 2 });
    const idempotencyKey = key('errored');
    const first = await gateway.commit(input(idempotencyKey));
    if (first.status !== 'queued') throw new Error(`expected queued, got ${first.status}`);
    starter.statuses.set(first.workflowInstanceId, 'errored');
    const retry = await gateway.commit(input(idempotencyKey));
    expect(retry).toEqual(first);
    expect(starter.restarts.get(first.workflowInstanceId)).toBe(1);
    expect(starter.statuses.get(first.workflowInstanceId)).toBe('queued');
  });

  it('reports storage_unavailable when the Workflow can be neither started nor found', async () => {
    const { gateway, starter } = await racingSetup(3, { inlineRetries: 2 });
    starter.failure = new Error('binding unavailable');
    expect(await errorOf(gateway.commit(input(key())))).toMatchObject({ code: 'storage_unavailable' });
  });

  it('reports storage_unavailable when no CommitWorkflow is configured', async () => {
    const { gateway } = await racingSetup(1, { inlineRetries: 0, withWorkflow: false });
    const error = await errorOf(gateway.commit(input(key())));
    expect(error).toMatchObject({ code: 'storage_unavailable', details: { retryable: true } });
    expect(error?.message).toContain('no CommitWorkflow');
  });

  it('never queues a commit with an expectedHead: a lost race is stale_head', async () => {
    const { gateway, rival, starter } = await racingSetup(1);
    const head = (await rival.resolveRef({ repo: REPO, ref: 'main' }))?.sha;
    const error = await errorOf(gateway.commit({ ...input(key()), expectedHead: head }));
    expect(error).toMatchObject({ code: 'stale_head', details: { branch: 'main', expectedHead: head } });
    expect(starter.creates).toBe(0);
  });

  it('a retry after the hand-off finds the commit the workflow wrote and replays it', async () => {
    const { gateway, rival } = await racingSetup(3, { inlineRetries: 2 });
    const idempotencyKey = key('after');
    await gateway.commit(input(idempotencyKey));
    const written = await rival.commit(input(idempotencyKey));
    expect(written.status).toBe('committed');
    const again = await gateway.commit(input(idempotencyKey));
    expect(again.status).toBe('replayed');
  });
});

describe('commit: refusals that are not contention', () => {
  it('reports storage_unavailable when the host refuses a push while the head is unchanged', async () => {
    const backend = new MemoryBackend();
    await seed(memoryGateway({}, backend).gateway, REPO);
    const fetch = refusingFetch(backend.fetch, {
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/main', status: 'ng', reason: 'protected branch' }],
    });
    const { gateway } = memoryGateway({ fetch }, backend);
    const error = await errorOf(gateway.commit(input(key())));
    expect(error).toMatchObject({ code: 'storage_unavailable' });
    expect(error?.message).toContain('protected branch');
  });

  it('reports storage_unavailable when the host cannot unpack the pack', async () => {
    const backend = new MemoryBackend();
    await seed(memoryGateway({}, backend).gateway, REPO);
    const fetch = refusingFetch(backend.fetch, { unpack: 'index-pack failed', refs: [] });
    const { gateway } = memoryGateway({ fetch }, backend);
    expect((await errorOf(gateway.commit(input(key()))))?.message).toContain('unpack index-pack failed');
  });

  it('reports storage_unavailable when the host answers a push with an HTTP error', async () => {
    const backend = new MemoryBackend();
    await seed(memoryGateway({}, backend).gateway, REPO);
    const fetch = async (request: Request) =>
      request.method === 'POST' ? new Response('nope', { status: 503 }) : backend.fetch(request);
    const { gateway } = memoryGateway({ fetch }, backend);
    expect(await errorOf(gateway.commit(input(key())))).toMatchObject({ code: 'storage_unavailable' });
  });
});

describe('commit: onPush notification', () => {
  it('tells the onPush hook about every accepted update, and nothing about a replay', async () => {
    const events: PushEvent[] = [];
    const { gateway } = memoryGateway({ onPush: async (event) => void events.push(event) });
    await gateway.createRepo({ repo: REPO });
    const idempotencyKey = key();
    const output = await gateway.commit(input(idempotencyKey));
    await gateway.commit(input(idempotencyKey));
    if (output.status !== 'committed') throw new Error('expected a commit');
    expect(events).toEqual([{ repo: REPO, updates: [output.refUpdate], pushedAt: expect.any(String) }]);
  });

  it('reports a failing hook to onPushError and still returns the commit', async () => {
    const failures: unknown[] = [];
    const { gateway } = memoryGateway({
      onPush: async () => Promise.reject(new Error('queue down')),
      onPushError: (error) => void failures.push(error),
    });
    await gateway.createRepo({ repo: REPO });
    expect((await gateway.commit(input(key()))).status).toBe('committed');
    expect(failures).toEqual([new Error('queue down')]);
  });

  it('drops a failing hook silently when no onPushError is given', async () => {
    const { gateway } = memoryGateway({ onPush: async () => Promise.reject(new Error('queue down')) });
    await gateway.createRepo({ repo: REPO });
    expect((await gateway.commit(input(key()))).status).toBe('committed');
  });
});
