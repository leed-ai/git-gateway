// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { encodeReportStatus } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import type { RefStatus } from '@leed-ai/git-gateway-core/schemas/report-status';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { createGatewayApp } from '../src/gateway-app.ts';
import { MAX_EVENT_UPDATES, pushEventsFrom } from '../src/proxy/push-events.ts';
import { RuleBranchPolicy } from '../src/policy/rule-branch-policy.ts';
import type { PushEvent } from '../src/workflows/push-event.ts';
import type { SyncBranchWorkflowParams } from '../src/workflows/sync-workflow-schemas.ts';
import { syncWorkflowId } from '../src/workflows/workflow-instance-id.ts';
import { FakeBackend } from './helpers/fake-backend.ts';
import { FakeWorkflowStarter } from './helpers/fake-workflow.ts';
import { settle } from './helpers/gateway-fixture.ts';
import { pushBody } from './helpers/push-builder.ts';
import {
  push,
  pushObjects,
  receivePackFixture,
  report,
  SIDE_BAND,
  type PushObjects,
} from './helpers/receive-pack-fixture.ts';

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

const RULE = { from: 'main', into: 'staging' };

/** A storage host answer reporting these per-ref statuses. */
const hostReport =
  (refs: RefStatus[], unpack = 'ok') =>
  () =>
    new Response(encodeReportStatus({ unpack, refs }, SIDE_BAND), {
      headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    });

/** A gateway with the main→staging sync rule, a fake SyncBranchWorkflow and a recording onPush hook. */
function syncing(options: Parameters<typeof receivePackFixture>[1] = {}) {
  const workflow = new FakeWorkflowStarter<SyncBranchWorkflowParams>();
  const events: PushEvent[] = [];
  const errors: unknown[] = [];
  const gateway = receivePackFixture(o, {
    syncRules: [RULE],
    syncWorkflow: workflow,
    onPush: async (event) => {
      events.push(event);
    },
    onPushError: (error) => errors.push(error),
    ...options,
  });
  return { ...gateway, workflow, events, errors };
}

describe('push events from the smart-HTTP proxy', () => {
  it('starts the SyncBranchWorkflow after an accepted git push to main, and tells onPush', async () => {
    const { app, workflow, events } = syncing();
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const response = await push(app, 'alice-token', body);
    expect((await report(response)).refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    await settle();
    const id = await syncWorkflowId('site', 'main', 'staging', o.child.sha);
    expect(workflow.instances).toEqual(
      new Map([[id, { repo: 'site', from: 'main', into: 'staging', fromHead: o.child.sha }]]),
    );
    expect(events).toEqual([
      {
        repo: 'site',
        updates: [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
        pushedAt: expect.any(String),
      },
    ]);
  });

  it('delivers push events without an audit hook, and when audit report reading is off', async () => {
    const { app, workflow } = syncing({ smartHttp: { maxAuditReportBytes: 0 } });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    await report(await push(app, 'alice-token', body));
    await settle();
    expect(workflow.creates).toBe(1);
  });

  it('starts nothing when the branch policy refuses the push', async () => {
    const { app, workflow, events, upstream } = syncing();
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const result = await report(await push(app, 'bob-token', body));
    expect(result.refs[0]?.status).toBe('ng');
    await settle();
    expect(upstream.received).toHaveLength(0);
    expect(workflow.creates).toBe(0);
    expect(events).toEqual([]);
  });

  it('starts nothing when the storage host refuses the update', async () => {
    const { app, workflow, events, upstream } = syncing();
    upstream.respond = hostReport([{ ref: 'refs/heads/main', status: 'ng', reason: 'fetch first' }]);
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    expect((await report(await push(app, 'alice-token', body))).refs[0]?.status).toBe('ng');
    await settle();
    expect(workflow.creates).toBe(0);
    expect(events).toEqual([]);
  });

  it('starts nothing when the host fails to unpack', async () => {
    const { app, workflow, events, upstream } = syncing();
    upstream.respond = hostReport([{ ref: 'refs/heads/main', status: 'ok' }], 'index-pack failed');
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    await push(app, 'alice-token', body).then(async (response) => response.arrayBuffer());
    await settle();
    expect(workflow.creates).toBe(0);
    expect(events).toEqual([]);
  });

  it('reports only the refs the host accepted from a partly refused push', async () => {
    const { app, workflow, events, upstream } = syncing();
    upstream.respond = hostReport([
      { ref: 'refs/heads/main', status: 'ng', reason: 'fetch first' },
      { ref: 'refs/heads/feature/x', status: 'ok' },
    ]);
    const body = await pushBody(
      [
        { ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha },
        { ref: 'refs/heads/feature/x', oldSha: ZERO_SHA, newSha: o.child.sha },
      ],
      [o.tree, o.child],
    );
    await report(await push(app, 'alice-token', body));
    await settle();
    expect(workflow.creates).toBe(0);
    expect(events.map((event) => event.updates)).toEqual([
      [{ ref: 'refs/heads/feature/x', oldSha: ZERO_SHA, newSha: o.child.sha }],
    ]);
  });

  it('passes a hook failure to onPushError and leaves the response alone', async () => {
    const failure = new Error('queue unavailable');
    const { app, errors, logs } = syncing({
      onPush: async () => {
        throw failure;
      },
    });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const response = await push(app, 'alice-token', body);
    expect(response.status).toBe(200);
    expect((await report(response)).refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    await settle();
    expect(errors).toHaveLength(1);
    const [error] = errors;
    if (!(error instanceof AggregateError)) throw new Error('expected an AggregateError');
    expect(error.errors).toEqual([failure]);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', message: 'onPush hook failed' }));
  });

  it('refuses to build a gateway whose sync rules have no SyncBranchWorkflow binding', () => {
    expect(() =>
      createGatewayApp({
        backend: new FakeBackend(),
        authenticator: { authenticate: async () => null },
        authorizer: { authorize: async () => true },
        branchPolicy: new RuleBranchPolicy({}),
        gateway: { syncRules: [RULE] },
      }),
    ).toThrow(/SyncBranchWorkflow/);
  });
});

/** An accepted ref outcome for branch b<index>. */
const ok = (index: number) => ({
  ref: `refs/heads/b${index}`,
  oldSha: ZERO_SHA,
  newSha: '1'.repeat(40),
  status: 'ok' as const,
  reason: null,
});

describe('pushEventsFrom', () => {
  it('splits a push larger than one event can carry', () => {
    const outcomes = Array.from({ length: MAX_EVENT_UPDATES + 1 }, (_, index) => ok(index));
    const events = pushEventsFrom('site', outcomes, '2026-11-20T09:30:00.000Z');
    expect(events.map((event) => event.updates.length)).toEqual([MAX_EVENT_UPDATES, 1]);
  });

  it('leaves out refused and unknown refs, and sends nothing without an accepted one', () => {
    const outcomes = [
      { ...ok(1), status: 'rejected' as const, reason: 'no' },
      { ...ok(2), status: 'unknown' as const },
    ];
    expect(pushEventsFrom('site', outcomes, '2026-11-20T09:30:00.000Z')).toEqual([]);
  });
});
