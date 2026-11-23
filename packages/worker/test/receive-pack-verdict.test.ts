// SPDX-License-Identifier: Apache-2.0
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { settle } from './helpers/gateway-fixture.ts';
import { commitObject, pushBody } from './helpers/push-builder.ts';
import {
  push,
  pushObjects,
  reasonOf,
  receivePackFixture,
  report,
  type PushObjects,
} from './helpers/receive-pack-fixture.ts';
import { RepositoryLocks } from './helpers/repository-locks.ts';

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

const MIB = 1024 * 1024;
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

/** `length` bytes that do not compress, so a pack carrying them is at least that long. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)));
  return bytes;
}

describe('receive-pack verdict', () => {
  it('answers a slowly proven non-fast-forward with ng, and the host never sees the push', async () => {
    const { app, upstream, backend, audits } = fixture();
    backend.readDelayMs = 100;
    upstream.stallTimeoutMs = 20;
    const response = await push(app, 'alice-token', await nonFastForward(backend));
    expect(response.status).toBe(200);
    const result = await report(response);
    expect(result.unpack).toBe('ok');
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(result.progress).toContain('git-gateway: refs/heads/main: main is protected');
    expect(upstream.received).toEqual([]);
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', reason: 'main is protected' }]);
  });

  it('proves the refusal with one isAncestor question when the backend offers it', async () => {
    const { app, upstream, backend } = fixture();
    backend.answerAncestry();
    const body = await nonFastForward(backend);
    const before = backend.commitReads;
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(backend.ancestryQueries).toBe(1);
    // The one commit read is the branch policy checking whether storage has the new commit.
    expect(backend.commitReads - before).toBe(1);
    expect(upstream.received).toEqual([]);
  });

  it('sends a slowly proven fast-forward whole, so a host with an idle timeout never waits on it', async () => {
    const { app, upstream, backend } = fixture();
    const mid = await commitObject([o.base.sha], 'mid');
    backend.addCommit(mid.sha, [o.base.sha]);
    const tip = await commitObject([mid.sha], 'tip');
    backend.readDelayMs = 100;
    upstream.stallTimeoutMs = 20;
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: tip.sha }],
      [o.tree, tip],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(upstream.last()).toMatchObject({ body, bodyError: null });
  });

  it('streams a fast-forward whose pack is too large to hold, proven from the pack alone', async () => {
    const locks = new RepositoryLocks();
    const { app, upstream } = fixture({ locks, smartHttp: { maxFastForwardPackBytes: MIB } });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }],
      [o.tree, o.child, await createObject('blob', noise(MIB + 1))],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(upstream.last()).toMatchObject({ body, bodyError: null });
    expect(locks.violations).toEqual([]);
  });

  it('refuses a too-large push whose proof needs storage, never reading it while the push is open', async () => {
    const locks = new RepositoryLocks();
    const { app, upstream, backend } = fixture({ locks, smartHttp: { maxFastForwardPackBytes: MIB } });
    const mid = await commitObject([o.base.sha], 'mid');
    backend.addCommit(mid.sha, [o.base.sha]);
    const tip = await commitObject([mid.sha], 'tip');
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: tip.sha }],
      [o.tree, tip, await createObject('blob', noise(MIB + 1))],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(reasonOf(result.refs[0])).toMatch(/could not verify .*proven from the pack alone/);
    expect(upstream.last().bodyError).not.toBeNull();
    expect(locks.violations).toEqual([]);
  });

  it('refuses a too-large non-fast-forward found in the pack, cutting the pack short', async () => {
    const { app, upstream, audits } = fixture({ smartHttp: { maxFastForwardPackBytes: MIB } });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.unrelated.sha }],
      [o.tree, o.unrelated, await createObject('blob', noise(MIB + 1))],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(upstream.last().bodyError).not.toBeNull();
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', refs: [{ status: 'rejected' }] }]);
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
});
