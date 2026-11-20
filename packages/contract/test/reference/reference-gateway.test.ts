// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { readGatewayError } from '../../src/gateway-error.ts';
import { steppingClock } from '../../src/reference/clock.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';

const AUTHOR = { name: 'Ada', email: 'ada@example.com' };
const upsert = (path: string, content: string) => [{ action: 'upsert' as const, path, content }];

async function scenario(gateway = createReferenceGateway({ now: steppingClock() })) {
  await gateway.createRepo({ repo: 'r' });
  const base = { repo: 'r', author: AUTHOR, message: 'm' };
  const first = await gateway.commit({
    ...base,
    branch: 'main',
    idempotencyKey: 'k1',
    actions: upsert('a', '1'),
  });
  const second = await gateway.commit({
    ...base,
    branch: 'main',
    idempotencyKey: 'k2',
    actions: upsert('b', '2'),
  });
  return { gateway, first, second, base };
}

describe('createReferenceGateway', () => {
  it('produces the same ids on every run with a stepping clock', async () => {
    const one = await scenario();
    const two = await scenario();
    expect(two.first).toEqual(one.first);
    expect(two.second).toEqual(one.second);
  });

  it('gives equal trees equal ids regardless of history', async () => {
    const { gateway, base } = await scenario();
    const c = await gateway.commit({
      ...base,
      branch: 'main',
      idempotencyKey: 'k3',
      actions: [{ action: 'delete', path: 'b' }],
    });
    const log = await gateway.log({ repo: 'r', ref: 'main' });
    expect(c.status).toBe('committed');
    expect(log.commits[0]?.tree).toBe(log.commits[2]?.tree);
  });

  it('honours publicBaseUrl, trimming a trailing slash', async () => {
    const gateway = createReferenceGateway({ config: { publicBaseUrl: 'https://git.leed.ai/' } });
    expect((await gateway.createRepo({ repo: 'site' })).remoteUrl).toBe('https://git.leed.ai/site.git');
    expect((await gateway.mintReadToken({ repo: 'site' })).remoteUrl).toBe('https://git.leed.ai/site.git');
  });

  it('uses the configured service identity for sync merges', async () => {
    const serviceIdentity = { name: 'Leed Sync', email: 'sync@leed.example' };
    const gateway = createReferenceGateway({ config: { serviceIdentity } });
    await gateway.createRepo({ repo: 'r' });
    const base = { repo: 'r', author: AUTHOR, message: 'm' };
    await gateway.commit({ ...base, branch: 'main', idempotencyKey: 'a', actions: upsert('a', '1') });
    await gateway.commit({
      ...base,
      branch: 'staging',
      startBranch: 'main',
      idempotencyKey: 'b',
      actions: upsert('b', '1'),
    });
    await gateway.commit({ ...base, branch: 'main', idempotencyKey: 'c', actions: upsert('c', '1') });
    const output = await gateway.syncBranch({ repo: 'r', from: 'main', into: 'staging' });
    expect(output.status === 'merged' ? output.commit.author : null).toMatchObject(serviceIdentity);
  });

  it('rejects an invalid configuration', () => {
    expect(() => createReferenceGateway({ config: { inlineRetries: -1 } })).toThrow(/inlineRetries/);
  });

  it('applies defaults from the input schemas', async () => {
    const { gateway } = await scenario();
    const file = await gateway.readFile({ repo: 'r', ref: 'main', path: 'a' });
    expect(file?.encoding).toBe('text');
    expect((await gateway.createRepo({ repo: 'other' })).defaultBranch).toBe('main');
  });

  it('reports invalid input with the failing paths', async () => {
    const gateway = createReferenceGateway();
    const thrown = await gateway.createRepo({ repo: '' }).catch((error: unknown) => error);
    const body = readGatewayError(thrown);
    expect(body?.code).toBe('invalid_input');
    expect(body?.code === 'invalid_input' ? body.details.issues.map((issue) => issue.path) : []).toContain(
      'repo',
    );
  });
});

describe('idempotency window', () => {
  it('stops looking after maxCommits', async () => {
    const gateway = createReferenceGateway({
      now: steppingClock(),
      config: { idempotency: { maxCommits: 2 } },
    });
    const { base } = await scenario(gateway);
    await gateway.commit({ ...base, branch: 'main', idempotencyKey: 'k3', actions: upsert('c', '3') });
    // k1 is now the third-newest commit, outside a two-commit window.
    const retry = await gateway.commit({
      ...base,
      branch: 'main',
      idempotencyKey: 'k1',
      actions: upsert('a', 'again'),
    });
    expect(retry.status).toBe('committed');
    const recent = await gateway.commit({
      ...base,
      branch: 'main',
      idempotencyKey: 'k3',
      actions: upsert('c', 'x'),
    });
    expect(recent.status).toBe('replayed');
  });

  it('stops looking after maxAgeSeconds', async () => {
    const gateway = createReferenceGateway({
      now: steppingClock('2026-01-01T00:00:00.000Z', 61_000),
      config: { idempotency: { maxAgeSeconds: 60 } },
    });
    const { base } = await scenario(gateway);
    // Each clock read is 61 s after the last, so k1 (two commits back) is older than 60 s.
    const retry = await gateway.commit({
      ...base,
      branch: 'main',
      idempotencyKey: 'k1',
      actions: upsert('a', 'again'),
    });
    expect(retry.status).toBe('committed');
  });
});
