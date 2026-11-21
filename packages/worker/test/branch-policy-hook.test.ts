// SPDX-License-Identifier: Apache-2.0
import type { BranchPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PolicyResult } from '@leed-ai/git-gateway-contract/proxy/policy-result';
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { settle } from './helpers/gateway-fixture.ts';
import { pushBody } from './helpers/push-builder.ts';
import {
  push,
  pushObjects,
  receivePackFixture,
  report,
  type PushObjects,
} from './helpers/receive-pack-fixture.ts';

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

/** A BranchPolicy that records what it was asked and answers with `decide`. */
function scriptedPolicy(decide: (updates: readonly RefUpdate[]) => PolicyResult) {
  const calls: { principal: Principal; repo: string; updates: readonly RefUpdate[] }[] = [];
  const policy: BranchPolicy = {
    check: (principal, repo, updates) => {
      calls.push({ principal, repo, updates });
      return decide(updates);
    },
  };
  return { policy, calls };
}

const allowAll = (updates: readonly RefUpdate[]): PolicyResult => ({
  refs: updates.map((update) => ({ ref: update.ref, decision: 'allow' })),
});

describe('the BranchPolicy hook', () => {
  it('is asked only about branch and tag updates, with the parsed principal and the repository', async () => {
    const { policy, calls } = scriptedPolicy(allowAll);
    const { app, upstream } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [
        { ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha },
        { ref: 'refs/tags/v2', oldSha: ZERO_SHA, newSha: o.child.sha },
        { ref: 'refs/notes/commits', oldSha: ZERO_SHA, newSha: o.child.sha },
      ],
      [o.tree, o.child],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.repo).toBe('site');
    expect(calls[0]?.principal).toMatchObject({ subject: 'alice', roles: ['maintainer'] });
    expect(calls[0]?.updates.map((update) => update.ref)).toEqual(['refs/heads/topic', 'refs/tags/v2']);
    expect(result.refs.find((ref) => ref.ref === 'refs/notes/commits')).toMatchObject({
      status: 'ng',
      reason: expect.stringMatching(/only branches/),
    });
    expect(upstream.received).toEqual([]);
  });

  it('is not asked at all when no update is a branch or tag', async () => {
    const { policy, calls } = scriptedPolicy(allowAll);
    const { app, upstream } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [{ ref: 'refs/notes/commits', oldSha: ZERO_SHA, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    expect((await report(await push(app, 'alice-token', body))).refs[0]?.status).toBe('ng');
    expect(calls).toEqual([]);
    expect(upstream.received).toEqual([]);
  });

  it('refuses a ref the policy made no decision for, and every other ref of the push with it', async () => {
    const { policy } = scriptedPolicy(() => ({
      refs: [{ ref: 'refs/heads/topic', decision: 'allow' }],
    }));
    const { app, upstream, audits } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [
        { ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha },
        { ref: 'refs/heads/other', oldSha: ZERO_SHA, newSha: o.child.sha },
      ],
      [o.tree, o.child],
    );
    expect((await report(await push(app, 'alice-token', body))).refs).toEqual([
      {
        ref: 'refs/heads/topic',
        status: 'ng',
        reason: 'not updated: another update in this push was refused',
      },
      { ref: 'refs/heads/other', status: 'ng', reason: 'the branch policy made no decision for this ref' },
    ]);
    expect(upstream.received).toEqual([]);
    await settle();
    expect(audits).toMatchObject([
      { outcome: 'denied', reason: 'the branch policy made no decision for this ref' },
    ]);
  });

  it('ignores decisions for refs the push did not name', async () => {
    const { policy } = scriptedPolicy((updates) => ({
      refs: [
        ...allowAll(updates).refs,
        { ref: 'refs/heads/elsewhere', decision: 'deny', reason: 'not part of this push' },
      ],
    }));
    const { app, upstream } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [{ ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    expect((await push(app, 'alice-token', body)).status).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });

  it('lets a fast-forward-only decision create a branch or a tag (there is no old head to lose)', async () => {
    const { policy } = scriptedPolicy((updates) => ({
      refs: updates.map((update) => ({
        ref: update.ref,
        decision: 'fast-forward-only',
        reason: 'fast-forwards only',
      })),
    }));
    const { app, upstream } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [
        { ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha },
        { ref: 'refs/tags/v3', oldSha: ZERO_SHA, newSha: o.child.sha },
      ],
      [o.tree, o.child],
    );
    expect((await push(app, 'alice-token', body)).status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.last().bodyError).toBeNull();
  });

  it('refuses a deletion under a fast-forward-only decision with its reason (no new commit contains the head)', async () => {
    const { policy } = scriptedPolicy((updates) => ({
      refs: updates.map((update) => ({
        ref: update.ref,
        decision: 'fast-forward-only',
        reason: 'main only moves forward',
      })),
    }));
    const { app, upstream, audits } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody([{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: ZERO_SHA }], null, [
      'report-status',
      'side-band-64k',
      'delete-refs',
    ]);
    expect((await report(await push(app, 'alice-token', body))).refs).toEqual([
      { ref: 'refs/heads/main', status: 'ng', reason: 'main only moves forward' },
    ]);
    expect(upstream.received).toEqual([]);
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', reason: 'main only moves forward' }]);
  });

  it('folds a carriage return the contract allows in a policy reason, so report-status keeps one line per ref', async () => {
    const reason = `main is protected\rok refs/heads/main ${'x'.repeat(400)}`;
    const { policy } = scriptedPolicy((updates) => ({
      refs: updates.map((update) => ({ ref: update.ref, decision: 'deny', reason })),
    }));
    const { app, upstream } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const { refs } = await report(await push(app, 'alice-token', body));
    expect(refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: reason.replaceAll('\r', ' ') }]);
    expect(upstream.received).toEqual([]);
  });

  it.each([
    [
      'throws',
      (): PolicyResult => {
        throw new Error('policy store down: secret-detail');
      },
    ],
    [
      'returns a result the contract refuses',
      (updates: readonly RefUpdate[]): PolicyResult => ({
        refs: updates.map((update) => ({ ref: update.ref, decision: 'deny', reason: '' })),
      }),
    ],
    [
      'names one ref twice, a deny then an allow',
      (updates: readonly RefUpdate[]): PolicyResult => ({
        refs: updates.flatMap((update): PolicyResult['refs'] => [
          { ref: update.ref, decision: 'deny', reason: 'main is protected' },
          { ref: update.ref, decision: 'allow' },
        ]),
      }),
    ],
  ])('forwards nothing and leaks no detail when the policy %s', async (_label, decide) => {
    const { policy } = scriptedPolicy(decide);
    const { app, upstream, logs, audits } = receivePackFixture(o, { branchPolicy: policy });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const response = await push(app, 'alice-token', body);
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Request-Id')).not.toBeNull();
    const text = await response.text();
    expect(text).toMatch(/branch policy is unavailable/);
    expect(text).not.toContain('secret-detail');
    expect(upstream.received).toEqual([]);
    expect(logs.some((entry) => entry.level === 'error' && entry.message === 'branch policy failed')).toBe(
      true,
    );
    await settle();
    expect(audits).toMatchObject([
      {
        outcome: 'failed',
        reason: 'The branch policy is unavailable; try again later',
        refs: [{ ref: 'refs/heads/main' }],
      },
    ]);
  });
});
