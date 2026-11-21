// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { startGatewayHarness, type GatewayHarness } from './gateway-harness.ts';

// A build clones through the gateway with a short-lived read token from mintReadToken(): the
// token works for its one repository, for fetching only.

let h: GatewayHarness;

beforeAll(async () => {
  h = await startGatewayHarness();
});

afterAll(async () => h.close());

/** A repository with one commit on main, pushed by alice. */
async function seeded(name: string): Promise<string> {
  const url = await h.repo(name);
  const seed = h.sandbox.path(`${name}-seed`);
  expect((await h.git('alice', ['clone', '-q', url, seed])).status).toBe(0);
  writeFileSync(`${seed}/README.md`, 'seed\n');
  await h.sandbox.ok(['add', '-A'], { cwd: seed });
  await h.sandbox.ok(['commit', '-q', '-m', 'seed'], { cwd: seed });
  expect((await h.git('alice', ['push', '-q', 'origin', 'main'], seed)).status).toBe(0);
  return url;
}

describe('read tokens minted over RPC', () => {
  it('clone the repository they name, and are refused a push and every other repository', async () => {
    const url = await seeded('built-site');
    const otherUrl = await seeded('other-site');
    const minted = await h.rpc.mintReadToken({ repo: 'built-site', ttlSeconds: 600 });
    expect(minted.remoteUrl).toBe(url);

    const work = h.sandbox.path('built-site-build');
    const cloned = await h.gitWith(minted.token, ['clone', '-q', minted.remoteUrl, work]);
    expect(cloned.status).toBe(0);
    expect(await h.sandbox.ok(['rev-parse', 'HEAD'], { cwd: work })).toBe(
      await h.backend.resolveRef('built-site', 'main'),
    );

    const before = await h.backend.resolveRef('built-site', 'main');
    writeFileSync(`${work}/build.txt`, 'built\n');
    await h.sandbox.ok(['add', '-A'], { cwd: work });
    await h.sandbox.ok(['commit', '-q', '-m', 'from the build'], { cwd: work });
    const pushed = await h.gitWith(minted.token, ['push', 'origin', 'main'], work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toMatch(/access denied: read-token:[0-9a-f]{32} may not push to built-site/);
    expect(await h.backend.resolveRef('built-site', 'main')).toBe(before);

    const elsewhere = await h.gitWith(minted.token, ['clone', '-q', otherUrl, h.sandbox.path('other-build')]);
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toMatch(/access denied: read-token:[0-9a-f]{32} may not read other-site/);
  });

  it('are refused once forged', async () => {
    const url = await seeded('forged-site');
    const { token } = await h.rpc.mintReadToken({ repo: 'forged-site', ttlSeconds: 600 });
    const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    const cloned = await h.gitWith(forged, ['clone', '-q', url, h.sandbox.path('forged-build')]);
    expect(cloned.status).not.toBe(0);
    expect(cloned.stderr).toMatch(/Authentication failed|401|could not read/i);
  });
});
