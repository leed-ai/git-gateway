// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { encodeReportStatus, parseReportStatus } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { basic, settle } from './helpers/gateway-fixture.ts';
import { pushBody } from './helpers/push-builder.ts';
import {
  push,
  pushObjects,
  receivePackFixture,
  SIDE_BAND,
  type PushObjects,
} from './helpers/receive-pack-fixture.ts';

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

const fixture = () => receivePackFixture(o);
const toMain = () => [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.child.sha }];

describe('receive-pack protocol edges', () => {
  it("answers git's auth probe (a lone flush) itself", async () => {
    const { app, upstream } = fixture();
    const response = await push(app, 'alice-token', '0000');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(upstream.received).toEqual([]);
  });

  it('refuses a malformed request with an ERR packet', async () => {
    const { app } = fixture();
    expect(await (await push(app, 'alice-token', 'zzzz')).text()).toMatch(/ERR malformed push/);
  });

  it('refuses with an ERR packet when the client did not ask for report-status', async () => {
    const { app } = fixture();
    const body = await pushBody(toMain(), [o.tree, o.child], ['agent=git/2.43.0']);
    expect(await (await push(app, 'bob-token', body)).text()).toMatch(/ERR main is protected/);
  });

  it('reports without a side-band when none was asked for', async () => {
    const { app } = fixture();
    const body = await pushBody(toMain(), [o.tree, o.child], ['report-status']);
    const bytes = new Uint8Array(await (await push(app, 'bob-token', body)).arrayBuffer());
    expect(parseReportStatus(bytes, { sideBand: 'none' }).refs[0]).toMatchObject({ status: 'ng' });
  });

  it('reads a gzip-compressed push and forwards it uncompressed', async () => {
    const { app, upstream } = fixture();
    const body = await pushBody(toMain(), [o.tree, o.child]);
    const gzipped = new Uint8Array(
      await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
    );
    await push(app, 'alice-token', gzipped, { 'Content-Encoding': 'gzip' });
    expect(upstream.last().body).toEqual(body);
    expect(upstream.last().headers.get('Content-Encoding')).toBeNull();
  });

  it('drops a protocol v2 request header on pushes', async () => {
    const { app, upstream } = fixture();
    const path = '/site.git/info/refs?service=git-receive-pack';
    await app.request(path, { headers: { ...basic('alice-token'), 'Git-Protocol': 'version=2' } });
    expect(upstream.last().headers.get('Git-Protocol')).toBeNull();
    await app.request(path, { headers: { ...basic('alice-token'), 'Git-Protocol': 'version=1' } });
    expect(upstream.last().headers.get('Git-Protocol')).toBe('version=1');
  });

  it('audits refs as unknown when the host report cannot be read, and as rejected when the host refused', async () => {
    const { app, upstream, audits } = fixture();
    upstream.respond = () => new Response('garbage');
    await push(app, 'alice-token', await pushBody(toMain(), [o.tree, o.child]));
    upstream.respond = () =>
      new Response(
        encodeReportStatus(
          { unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ng', reason: 'failed to lock' }] },
          SIDE_BAND,
        ),
      );
    await push(app, 'alice-token', await pushBody(toMain(), [o.tree, o.child]));
    await settle();
    expect(audits.map((event) => event.refs[0]?.status)).toEqual(['unknown', 'rejected']);
    expect(audits[1]?.refs[0]?.reason).toBe('failed to lock');
  });

  it('audits refs as unknown when the host report is larger than the audit limit', async () => {
    const { app, upstream, audits } = receivePackFixture(o, { smartHttp: { maxAuditReportBytes: 4 } });
    upstream.respond = () =>
      new Response(
        encodeReportStatus({ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] }, SIDE_BAND),
      );
    const response = await push(app, 'alice-token', await pushBody(toMain(), [o.tree, o.child]));
    expect(parseReportStatus(new Uint8Array(await response.arrayBuffer()), SIDE_BAND).refs[0]?.status).toBe(
      'ok',
    );
    await settle();
    expect(audits[0]?.refs[0]?.status).toBe('unknown');
  });

  it('answers 502 and audits a failure when the host is unreachable during a push', async () => {
    const { app, upstream, audits } = fixture();
    upstream.respond = () => {
      throw new TypeError('reset');
    };
    const body = await pushBody(
      [{ ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    expect((await push(app, 'alice-token', body)).status).toBe(502);
    await settle();
    expect(audits[0]).toMatchObject({ outcome: 'failed', refs: [{ status: 'unknown' }] });
  });

  it('answers the host failure when the push is forwarded but refused by the host with an error status', async () => {
    const { app, upstream, audits } = fixture();
    upstream.respond = () => new Response('nope', { status: 500 });
    const body = await pushBody(
      [{ ref: 'refs/heads/topic', oldSha: ZERO_SHA, newSha: o.child.sha }],
      [o.tree, o.child],
    );
    expect((await push(app, 'alice-token', body)).status).toBe(502);
    await settle();
    expect(audits[0]).toMatchObject({ outcome: 'failed' });
  });
});
