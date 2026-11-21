// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { encodeReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/encode-request';
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

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

const fixture = (options: Parameters<typeof receivePackFixture>[1] = {}) => receivePackFixture(o, options);
const update = (ref: string, oldSha: string, newSha: string) => [{ ref, oldSha, newSha }];

/**
 * A commit on the empty tree that names `parent` on a header line after the committer: a naive
 * reader sees a child of `parent`, git sees a root commit.
 */
async function misplacedParentCommit(parent: string) {
  const ident = 'Ada <ada@example.com> 1700000000 +0000';
  return createObject(
    'commit',
    new TextEncoder().encode(
      `tree ${o.tree.sha}\nauthor ${ident}\ncommitter ${ident}\nparent ${parent}\n\nforce\n`,
    ),
  );
}

describe('receive-pack branch policy', () => {
  it('forwards a fast-forward proven from the pushed pack, byte for byte', async () => {
    const { app, upstream, audits } = fixture();
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.child.sha), [o.tree, o.child]);
    const response = await push(app, 'alice-token', body);
    expect(response.status).toBe(200);
    expect((await report(response)).refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(upstream.last().body).toEqual(body);
    expect(upstream.last().headers.get('Authorization')).toBe('Bearer upstream-secret-1');
    await settle();
    expect(audits).toMatchObject([
      {
        outcome: 'allowed',
        operation: 'write',
        refs: [{ ref: 'refs/heads/main', status: 'ok', reason: null }],
      },
    ]);
  });

  it('refuses a force push found in the pack: the host gets a truncated pack and the client an ng', async () => {
    const { app, upstream, audits } = fixture();
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.unrelated.sha), [
      o.tree,
      o.unrelated,
    ]);
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(result.progress).toContain('git-gateway: refs/heads/main: main is protected');
    expect(upstream.last().bodyError).not.toBeNull();
    await settle();
    expect(audits).toMatchObject([
      { outcome: 'denied', reason: 'main is protected', refs: [{ status: 'rejected' }] },
    ]);
  });

  it('refuses a force push to a commit storage already has before anything is forwarded', async () => {
    const { app, upstream, backend } = fixture();
    backend.addCommit(o.unrelated.sha, []);
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.unrelated.sha), []);
    expect((await report(await push(app, 'alice-token', body))).refs).toEqual([
      { ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' },
    ]);
    expect(upstream.received).toEqual([]);
  });

  it('forwards a fast-forward to a commit storage already has', async () => {
    const { app, upstream, backend } = fixture();
    backend.addCommit(o.child.sha, [o.base.sha]);
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.child.sha), []);
    expect((await report(await push(app, 'alice-token', body))).refs[0]?.status).toBe('ok');
    expect(upstream.received.length).toBe(1);
  });

  it('allows force pushes where a rule allows them', async () => {
    const { app, upstream } = fixture();
    const body = await pushBody(update('refs/heads/feature/x', o.base.sha, o.unrelated.sha), [
      o.tree,
      o.unrelated,
    ]);
    expect((await push(app, 'bob-token', body)).status).toBe(200);
    expect(upstream.last().bodyError).toBeNull();
  });

  it('refuses a protected ref to principals the rule does not name, with its readable message', async () => {
    const { app, upstream } = fixture();
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.child.sha), [o.tree, o.child]);
    expect((await report(await push(app, 'bob-token', body))).refs).toEqual([
      { ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' },
    ]);
    expect(upstream.received).toEqual([]);
  });

  it('refuses deleting a protected branch and allows creating and deleting others', async () => {
    const { app, upstream } = fixture();
    const deleting = await push(
      app,
      'alice-token',
      await pushBody(update('refs/heads/main', o.base.sha, ZERO_SHA), null),
    );
    expect((await report(deleting)).refs[0]).toMatchObject({ status: 'ng', reason: 'main is protected' });
    expect(upstream.received).toEqual([]);
    await push(
      app,
      'bob-token',
      await pushBody(update('refs/heads/topic', ZERO_SHA, o.child.sha), [o.tree, o.child]),
    );
    await push(app, 'bob-token', await pushBody(update('refs/heads/topic', o.child.sha, ZERO_SHA), null));
    expect(upstream.received.length).toBe(2);
  });

  it('refuses moving a tag unless force pushes are allowed, and refs outside heads and tags always', async () => {
    const { app, upstream } = fixture();
    const moved = await push(
      app,
      'alice-token',
      await pushBody(update('refs/tags/v1', o.base.sha, o.child.sha), [o.tree, o.child]),
    );
    expect((await report(moved)).refs[0]).toMatchObject({
      status: 'ng',
      reason: 'force-pushing tag v1 is not allowed',
    });
    const notes = await push(
      app,
      'alice-token',
      await pushBody(update('refs/notes/commits', ZERO_SHA, o.child.sha), [o.tree, o.child]),
    );
    expect(reasonOf((await report(notes)).refs[0])).toMatch(/only branches/);
    expect(upstream.received).toEqual([]);
  });

  it('refuses the whole push when any update is refused', async () => {
    const { app, upstream } = fixture();
    const body = await pushBody(
      [
        { ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha },
        { ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha },
      ],
      [o.tree, o.child],
    );
    expect((await report(await push(app, 'bob-token', body))).refs).toEqual([
      {
        ref: 'refs/heads/topic',
        status: 'ng',
        reason: 'not updated: another update in this push was refused',
      },
      { ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' },
    ]);
    expect(upstream.received).toEqual([]);
  });

  it('refuses as unverifiable when the ancestry walk runs past its limit or storage fails', async () => {
    const limited = fixture({ smartHttp: { maxAncestryReads: 1 } });
    const deep = await commitObject([o.base.sha], 'deep');
    limited.backend.addCommit(deep.sha, [o.base.sha]);
    const grandchild = await commitObject([deep.sha], 'grandchild');
    limited.backend.addCommit(grandchild.sha, [deep.sha]);
    const tip = await commitObject([grandchild.sha], 'tip');
    const body = await pushBody(update('refs/heads/main', o.base.sha, tip.sha), [o.tree, tip]);
    expect(reasonOf((await report(await push(limited.app, 'alice-token', body))).refs[0])).toMatch(
      /could not verify/,
    );
    const failing = fixture();
    failing.backend.failReads = true;
    const failed = await push(
      failing.app,
      'alice-token',
      await pushBody(update('refs/heads/main', o.base.sha, o.child.sha), [o.tree, o.child]),
    );
    expect(reasonOf((await report(failed)).refs[0])).toMatch(/could not verify/);
  });

  it('refuses a pack that cannot be read', async () => {
    const { app, upstream } = fixture();
    const body = encodeReceivePackRequest({
      commands: update('refs/heads/main', o.base.sha, o.child.sha),
      capabilities: ['report-status', 'side-band-64k'],
      pack: new TextEncoder().encode('PACK not really a pack at all......'),
    });
    expect(reasonOf((await report(await push(app, 'alice-token', body))).refs[0])).toMatch(
      /pushed pack could not be checked/,
    );
    expect(upstream.last().bodyError).not.toBeNull();
  });

  it('refuses a commit whose parent line git ignores, when it comes in the pack', async () => {
    const { app, upstream, audits } = fixture();
    const crafted = await misplacedParentCommit(o.base.sha);
    const body = await pushBody(update('refs/heads/main', o.base.sha, crafted.sha), [o.tree, crafted]);
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([
      { ref: 'refs/heads/main', status: 'ng', reason: expect.stringMatching(/could not verify/) },
    ]);
    expect(upstream.last().bodyError).not.toBeNull();
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', refs: [{ status: 'rejected' }] }]);
  });

  it('refuses a commit whose parent line git ignores, when storage already has it', async () => {
    const { app, upstream, backend } = fixture();
    const crafted = await misplacedParentCommit(o.base.sha);
    backend.rawCommits.set(crafted.sha, crafted.data);
    const body = await pushBody(update('refs/heads/main', o.base.sha, crafted.sha), []);
    expect((await report(await push(app, 'alice-token', body))).refs).toEqual([
      { ref: 'refs/heads/main', status: 'ng', reason: expect.stringMatching(/could not verify/) },
    ]);
    expect(upstream.received).toEqual([]);
  });

  it('still refuses a force push in the pack when the host answers before reading the body', async () => {
    const { app, upstream, audits } = fixture();
    upstream.answerBeforeBody = true;
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.unrelated.sha), [
      o.tree,
      o.unrelated,
    ]);
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    await upstream.bodyRead;
    expect(upstream.last().bodyError).not.toBeNull();
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', reason: 'main is protected' }]);
  });

  it('forwards the host answer once a fast-forward is proven, when the host answers before reading', async () => {
    const { app, upstream, audits } = fixture();
    upstream.answerBeforeBody = true;
    const body = await pushBody(update('refs/heads/main', o.base.sha, o.child.sha), [o.tree, o.child]);
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    await upstream.bodyRead;
    expect(upstream.last().body).toEqual(body);
    await settle();
    expect(audits).toMatchObject([{ outcome: 'allowed', refs: [{ status: 'ok' }] }]);
  });
});
