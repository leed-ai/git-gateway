// SPDX-License-Identifier: Apache-2.0
import { writePack } from '@leed-ai/git-gateway-core/pack/write-pack';
import { encodeReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/encode-request';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { disallowedPushOptions, pushOptionName, pushOptionsReason } from '../src/proxy/push-options.ts';
import { settle } from './helpers/gateway-fixture.ts';
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

/** A push of a feature branch carrying these push options. */
async function withOptions(pushOptions: string[]): Promise<Uint8Array> {
  return encodeReceivePackRequest({
    commands: [{ ref: 'refs/heads/feature/x', oldSha: '0'.repeat(40), newSha: o.child.sha }],
    capabilities: ['report-status', 'side-band-64k', 'push-options', 'agent=git/2.43.0'],
    pushOptions,
    pack: await writePack([o.tree, o.child]),
  });
}

const MERGE_TO_MAIN = [
  'merge_request.create',
  'merge_request.target=main',
  'merge_request.merge_when_pipeline_succeeds',
];

describe('push options', () => {
  it('refuses a push asking the host to open and auto-merge a merge request, before storage sees it', async () => {
    const { app, upstream, audits } = receivePackFixture(o);
    const result = await report(await push(app, 'bob-token', await withOptions(MERGE_TO_MAIN)));
    const reason =
      'push options "merge_request.create", "merge_request.target", "merge_request.merge_when_pipeline_succeeds" not allowed by this gateway';
    expect(result.refs).toEqual([{ ref: 'refs/heads/feature/x', status: 'ng', reason }]);
    expect(result.progress).toContain(`git-gateway: refs/heads/feature/x: ${reason}`);
    expect(upstream.received).toHaveLength(0);
    await settle();
    expect(audits).toMatchObject([{ outcome: 'denied', reason, refs: [{ status: 'rejected', reason }] }]);
  });

  it('never echoes an option value, which may be a secret', async () => {
    const { app } = receivePackFixture(o);
    const result = await report(
      await push(app, 'alice-token', await withOptions(['ci.variable=TOKEN=s3cret'])),
    );
    expect(JSON.stringify(result)).not.toContain('s3cret');
    expect(result.refs[0]).toMatchObject({
      status: 'ng',
      reason: 'push option "ci.variable" not allowed by this gateway',
    });
  });

  it('forwards a push whose options are all on the allowlist, byte for byte', async () => {
    const { app, upstream } = receivePackFixture(o, { smartHttp: { allowedPushOptions: ['ci.skip'] } });
    upstream.respond = () => new Response(null, { status: 200 });
    const body = await withOptions(['ci.skip']);
    expect((await push(app, 'alice-token', body)).status).toBe(200);
    expect(upstream.last().body).toEqual(body);
  });

  it('refuses an option off the allowlist even beside allowed ones', async () => {
    const { app, upstream } = receivePackFixture(o, { smartHttp: { allowedPushOptions: ['ci.skip'] } });
    const result = await report(
      await push(app, 'alice-token', await withOptions(['ci.skip', 'merge_request.create'])),
    );
    expect(result.refs[0]?.status).toBe('ng');
    expect(upstream.received).toHaveLength(0);
  });
});

describe('push option helpers', () => {
  it('names an option by the text before its first "="', () => {
    expect(pushOptionName('ci.variable=A=b')).toBe('ci.variable');
    expect(pushOptionName('ci.skip')).toBe('ci.skip');
    expect(pushOptionName('')).toBe('');
  });

  it('lists each refused name once, in order', () => {
    const request = { pushOptions: ['b', 'a=1', 'b=2', 'ok'] };
    expect(disallowedPushOptions(request, ['ok'])).toEqual(['b', 'a']);
    expect(disallowedPushOptions({ pushOptions: [] }, [])).toEqual([]);
  });

  it('names at most five options in the reason', () => {
    expect(pushOptionsReason(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(
      'push options "a", "b", "c", "d", "e" and 2 more not allowed by this gateway',
    );
  });
});
