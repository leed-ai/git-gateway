// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { settle } from './helpers/gateway-fixture.ts';
import { commitObject, pushBody } from './helpers/push-builder.ts';
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

const fixture = (options: Parameters<typeof receivePackFixture>[1] = {}) => receivePackFixture(o, options);

/**
 * A push to main of a new commit whose parent is `side`, a root commit storage holds that does
 * not descend from main's head: a non-fast-forward the gateway can only refuse after reading
 * `side` from storage, which takes `readDelayMs` per read.
 */
async function nonFastForward(backend: ReturnType<typeof fixture>['backend']) {
  const side = await commitObject([], 'side');
  backend.addCommit(side.sha, []);
  const tip = await commitObject([side.sha], 'rewritten');
  return pushBody([{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: tip.sha }], [o.tree, tip]);
}

describe('receive-pack verdict when the storage host fails first', () => {
  it('answers a refused non-fast-forward with ng, not 502, when the host gives up before the verdict', async () => {
    const { app, upstream, backend, audits } = fixture();
    backend.readDelayMs = 100;
    upstream.stallTimeoutMs = 20;
    const response = await push(app, 'alice-token', await nonFastForward(backend));
    expect(response.status).toBe(200);
    const result = await report(response);
    expect(result.unpack).toBe('ok');
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(result.progress).toContain('git-gateway: refs/heads/main: main is protected');
    expect(upstream.last().bodyError).not.toBeNull();
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', reason: 'main is protected' }]);
  });

  it('proves the refusal with one isAncestor question when the backend offers it', async () => {
    const { app, upstream, backend } = fixture();
    backend.answerAncestry();
    upstream.stallTimeoutMs = 20;
    const body = await nonFastForward(backend);
    const before = backend.commitReads;
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(backend.ancestryQueries).toBe(1);
    // The one commit read is the branch policy checking whether storage has the new commit.
    expect(backend.commitReads - before).toBe(1);
  });

  it('still answers 502 for a genuine host failure of an allowed push, and audits it as failed', async () => {
    const { app, upstream, audits } = fixture();
    upstream.respond = () => {
      throw new Error('connection reset');
    };
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    const response = await push(app, 'alice-token', body);
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/unreachable/);
    await settle();
    expect(audits).toMatchObject([{ outcome: 'failed', refs: [{ status: 'unknown' }] }]);
  });

  it('gives up waiting for the verdict after maxVerdictWaitMs and fails closed with 502', async () => {
    const { app, upstream, backend } = fixture({ smartHttp: { maxVerdictWaitMs: 10 } });
    backend.readDelayMs = 300;
    upstream.stallTimeoutMs = 20;
    const response = await push(app, 'alice-token', await nonFastForward(backend));
    expect(response.status).toBe(502);
    expect(upstream.last().bodyError).not.toBeNull();
  });
});
