// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { describe, expect, it } from 'vite-plus/test';

import { gatewayContext } from '../../src/rpc/gateway-context.ts';
import {
  composeOnPush,
  consumePushEvents,
  dispatchPushEvent,
  syncRuleHook,
  type OnPushHook,
} from '../../src/workflows/on-push.ts';
import { runSyncWorkflow } from '../../src/workflows/run-sync-workflow.ts';
import type { SyncBranchWorkflowParams } from '../../src/workflows/sync-workflow-schemas.ts';
import { syncWorkflowId } from '../../src/workflows/workflow-instance-id.ts';
import { FakeStepRunner, FakeWorkflowStarter } from '../helpers/fake-workflow.ts';
import { memoryGateway, SECRET, seed, write } from '../helpers/memory-gateway.ts';

const A = '1'.repeat(40);
const B = '2'.repeat(40);
const RULES = [
  { from: 'main', into: 'staging' },
  { from: 'main', into: 'preview' },
];

const push = (ref: string, oldSha: string, newSha: string, repo = 'acme') => ({
  repo,
  updates: [{ ref, oldSha, newSha }],
  pushedAt: '2026-11-20T09:30:00.000Z',
});

describe('syncRuleHook', () => {
  it('starts one SyncBranchWorkflow per rule whose from branch the push moved', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    await dispatchPushEvent(push('refs/heads/main', A, B), [syncRuleHook(RULES, starter)]);
    expect(starter.instances).toEqual(
      new Map([
        [
          await syncWorkflowId('acme', 'main', 'staging', B),
          { repo: 'acme', from: 'main', into: 'staging', fromHead: B },
        ],
        [
          await syncWorkflowId('acme', 'main', 'preview', B),
          { repo: 'acme', from: 'main', into: 'preview', fromHead: B },
        ],
      ]),
    );
  });

  it('ignores other branches, tags and deletions', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const hooks = [syncRuleHook(RULES, starter)];
    await dispatchPushEvent(push('refs/heads/staging', A, B), hooks);
    await dispatchPushEvent(push('refs/tags/main', ZERO_SHA, B), hooks);
    await dispatchPushEvent(push('refs/heads/main', A, ZERO_SHA), hooks);
    expect(starter.creates).toBe(0);
  });

  it('starts nothing new when the same push is delivered twice', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const hooks = [syncRuleHook([{ from: 'main', into: 'staging' }], starter)];
    await dispatchPushEvent(push('refs/heads/main', A, B), hooks);
    await dispatchPushEvent(push('refs/heads/main', A, B), hooks);
    expect(starter.instances.size).toBe(1);
  });

  it('restarts a sync that failed when the same push is delivered again', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const hooks = [syncRuleHook([{ from: 'main', into: 'staging' }], starter)];
    await dispatchPushEvent(push('refs/heads/main', A, B), hooks);
    const id = await syncWorkflowId('acme', 'main', 'staging', B);
    starter.statuses.set(id, 'errored');
    await dispatchPushEvent(push('refs/heads/main', A, B), hooks);
    expect(starter.instances.size).toBe(1);
    expect(starter.restarts.get(id)).toBe(1);
  });

  it('uses the last update of the branch when a push names it more than once', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const event = {
      ...push('refs/heads/main', ZERO_SHA, A),
      updates: [] as { ref: string; oldSha: string; newSha: string }[],
    };
    event.updates.push(
      { ref: 'refs/heads/main', oldSha: ZERO_SHA, newSha: A },
      { ref: 'refs/heads/main', oldSha: A, newSha: B },
    );
    await dispatchPushEvent(event, [syncRuleHook([{ from: 'main', into: 'staging' }], starter)]);
    expect([...starter.instances.values()].map((params) => params.fromHead)).toEqual([B]);
  });

  it('drives a real sync end to end: push to main, then the workflow syncs staging', async () => {
    const { gateway, context, backend } = memoryGateway();
    await seed(gateway, 'acme');
    const seedHead = (await gateway.resolveRef({ repo: 'acme', ref: 'main' }))?.sha ?? '';
    await gateway.promote({ repo: 'acme', from: 'main', into: 'staging', sha: seedHead });
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const hooked = memoryGateway(
      { onPush: syncRuleHook([{ from: 'main', into: 'staging' }], starter) },
      backend,
    );
    const head = await write(hooked.gateway, 'acme', 'main', { 'n.md': 'n' });
    const [params] = [...starter.instances.values()];
    expect(params).toEqual({ repo: 'acme', from: 'main', into: 'staging', fromHead: head });
    expect(await runSyncWorkflow(context, params, new FakeStepRunner())).toEqual({
      status: 'fast_forward',
      head,
    });
  });
});

describe('configured sync rules', () => {
  it('start a SyncBranchWorkflow after an RPC write when the binding is supplied', async () => {
    const starter = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
    const seen: string[] = [];
    const { gateway } = memoryGateway({
      config: { syncRules: [{ from: 'main', into: 'staging' }] },
      syncWorkflow: starter,
      onPush: async (event) => void seen.push(event.repo),
    });
    await seed(gateway, 'acme');
    const head = await write(gateway, 'acme', 'main', { 'n.md': 'n' });
    expect([...starter.instances.values()]).toContainEqual({
      repo: 'acme',
      from: 'main',
      into: 'staging',
      fromHead: head,
    });
    expect(seen).toContain('acme');
  });

  it('refuse to run without a SyncBranchWorkflow binding', () => {
    expect(() =>
      gatewayContext({
        backend: memoryGateway().backend,
        readTokenSecret: SECRET,
        config: { syncRules: [{ from: 'main', into: 'staging' }] },
      }),
    ).toThrow(TypeError);
  });

  it('compose to nothing when there are neither rules nor a hook', () => {
    expect(composeOnPush({ syncRules: [] })).toBeUndefined();
  });
});

describe('dispatchPushEvent', () => {
  it('refuses something that is not a push event', async () => {
    const error: unknown = await dispatchPushEvent({ repo: 'acme', updates: [] }, []).catch(
      (e: unknown) => e,
    );
    expect(readGatewayError(error)?.code).toBe('invalid_input');
  });

  it('runs every hook even when one fails, then reports the failures together', async () => {
    const ran: string[] = [];
    const hooks: OnPushHook[] = [
      async () => Promise.reject(new Error('first failed')),
      async (event) => void ran.push(event.repo),
    ];
    const error: unknown = await dispatchPushEvent(push('refs/heads/main', A, B), hooks).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(ran).toEqual(['acme']);
  });
});

/** A queue message that records whether it was acknowledged or retried. */
function message(body: unknown) {
  const calls: string[] = [];
  return { body, calls, ack: () => void calls.push('ack'), retry: () => void calls.push('retry') };
}

/** A hook that fails for the repository named "flaky". */
const flakyHook: OnPushHook = async (event) => {
  if (event.repo === 'flaky') throw new Error('try later');
};

describe('consumePushEvents', () => {
  it('acks delivered events, retries failed ones and drops what is not an event', async () => {
    const good = message(push('refs/heads/main', A, B));
    const failing = message(push('refs/heads/main', A, B, 'flaky'));
    const junk = message({ hello: 'world' });
    const outcome = await consumePushEvents({ messages: [good, failing, junk] }, [flakyHook]);
    expect(outcome).toEqual({ delivered: 1, dropped: 1, retried: 1 });
    expect([good.calls, failing.calls, junk.calls]).toEqual([['ack'], ['retry'], ['ack']]);
  });
});
