// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { startGatewayHarness, type GatewayHarness } from './gateway-harness.ts';

// The real git binary cloning and fetching through the gateway (JWT credentials from a credential
// helper, the in-memory backend behind it), modelled on git's t5551-http-fetch-smart and
// t5537-fetch-shallow.

let h: GatewayHarness;
let url: string;
let count = 0;

beforeAll(async () => {
  h = await startGatewayHarness();
  url = await h.repo('fetching');
  const work = h.sandbox.path('seed');
  await h.sandbox.ok(['init', '-q', work]);
  await h.sandbox.ok(['remote', 'add', 'origin', url], { cwd: work });
  for (let round = 1; round <= 5; round += 1) {
    writeFileSync(`${work}/file.txt`, `round ${round}\n`);
    await h.sandbox.ok(['add', '-A'], { cwd: work });
    await h.sandbox.ok(['commit', '-q', '-m', `round ${round}`], { cwd: work });
  }
  const pushed = await h.git('alice', ['push', '-q', 'origin', 'main'], work);
  if (pushed.status !== 0) throw new Error(`seeding the repository failed: ${pushed.stderr}`);
});

afterAll(async () => h.close());

const dir = (name: string): string => {
  count += 1;
  return h.sandbox.path(`${name}-${count}`);
};

describe('fetching through the gateway with the git binary', () => {
  it('answers 401 first, then clones with the credential the helper supplied', async () => {
    const before = h.logs.filter((message) => message === 'authentication required').length;
    const target = dir('clone');
    const clone = await h.git('bob', ['clone', url, target]);
    expect(clone.status).toBe(0);
    expect(readFileSync(`${target}/file.txt`, 'utf8')).toBe('round 5\n');
    expect(h.logs.filter((message) => message === 'authentication required').length).toBe(before + 1);
    await h.sandbox.ok(['fsck', '--strict'], { cwd: target });
  });

  it('fails cleanly without a credential helper', async () => {
    const clone = await h.git(null, ['clone', url, dir('anonymous')]);
    expect(clone.status).not.toBe(0);
    expect(clone.stderr).toMatch(/Authentication failed|could not read Username|terminal prompts disabled/);
  });

  it('refuses an expired credential, so git reports the authentication failure', async () => {
    const clone = await h.git('expired', ['clone', url, dir('expired')]);
    expect(clone.status).not.toBe(0);
    expect(clone.stderr).toMatch(/Authentication failed/);
  });

  it.each(['0', '1', '2'])('clones and fetches with protocol.version=%s', async (version) => {
    const target = dir(`v${version}`);
    expect(
      (await h.git('reader', ['-c', `protocol.version=${version}`, 'clone', '-q', url, target])).status,
    ).toBe(0);
    const fetched = await h.git('reader', ['-c', `protocol.version=${version}`, 'fetch', 'origin'], target);
    expect(fetched.status).toBe(0);
    expect(await h.sandbox.ok(['rev-parse', 'origin/main'], { cwd: target })).toBe(
      await h.backend.resolveRef('fetching', 'main'),
    );
  });

  it('makes a shallow clone and deepens it', async () => {
    const target = dir('shallow');
    const shallow = await h.git('reader', ['clone', '-q', '--depth', '1', url, target]);
    expect(shallow.stderr).toBe('');
    expect(shallow.status).toBe(0);
    expect(await h.sandbox.ok(['rev-list', '--count', 'HEAD'], { cwd: target })).toBe('1');
    const deepened = await h.git('reader', ['fetch', '-q', '--depth', '3'], target);
    expect(deepened.stderr).toBe('');
    expect(deepened.status).toBe(0);
    expect(await h.sandbox.ok(['rev-list', '--count', 'HEAD'], { cwd: target })).toBe('3');
    expect((await h.git('reader', ['fetch', '-q', '--unshallow'], target)).status).toBe(0);
    expect(await h.sandbox.ok(['rev-list', '--count', 'HEAD'], { cwd: target })).toBe('5');
  });

  it('fetches only what is new', async () => {
    const target = dir('incremental');
    expect((await h.git('alice', ['clone', '-q', url, target])).status).toBe(0);
    writeFileSync(`${target}/new.txt`, 'new\n');
    await h.sandbox.ok(['add', '-A'], { cwd: target });
    await h.sandbox.ok(['commit', '-q', '-m', 'new'], { cwd: target });
    expect((await h.git('alice', ['push', '-q', 'origin', 'main'], target)).status).toBe(0);
    const other = dir('other');
    expect((await h.git('reader', ['clone', '-q', url, other])).status).toBe(0);
    expect(readFileSync(`${other}/new.txt`, 'utf8')).toBe('new\n');
  });

  it('answers a missing repository with "not found"', async () => {
    const clone = await h.git('alice', ['clone', `${h.url}/missing.git`, dir('missing')]);
    expect(clone.status).not.toBe(0);
    expect(clone.stderr).toMatch(/not found/);
  });
});
