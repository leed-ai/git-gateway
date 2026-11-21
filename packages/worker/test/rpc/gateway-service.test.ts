// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext } from 'cloudflare:test';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { describe, expect, it } from 'vite-plus/test';

import { createGatewayService } from '../../src/rpc/gateway-service.ts';
import { AUTHOR, SECRET } from '../helpers/memory-gateway.ts';

interface TestEnv {
  readonly backend: MemoryBackend;
  readonly secret: string;
}

const GatewayService = createGatewayService((env: TestEnv) => ({
  backend: env.backend,
  readTokenSecret: env.secret,
  fetch: env.backend.fetch,
}));

function service(env: TestEnv = { backend: new MemoryBackend(), secret: SECRET }) {
  return new GatewayService(createExecutionContext(), env);
}

describe('createGatewayService', () => {
  it('is a WorkerEntrypoint serving every method of the contract', () => {
    const instance = service();
    expect(instance).toBeInstanceOf(WorkerEntrypoint);
    for (const name of [
      'commit',
      'readFile',
      'listTree',
      'resolveRef',
      'log',
      'commitExists',
      'syncBranch',
      'promote',
      'createRepo',
      'deleteRepo',
      'mintReadToken',
    ]) {
      expect(typeof Reflect.get(Object.getPrototypeOf(instance), name)).toBe('function');
    }
  });

  it('runs every call through the backend its environment names', async () => {
    const env = { backend: new MemoryBackend(), secret: SECRET };
    const instance = service(env);
    await instance.createRepo({ repo: 'svc' });
    const committed = await instance.commit({
      repo: 'svc',
      branch: 'main',
      message: 'Hello',
      author: AUTHOR,
      idempotencyKey: 'svc-1',
      actions: [{ action: 'create', path: 'a.md', content: 'a' }],
    });
    expect(committed.status).toBe('committed');
    // A second instance (a second request) sees the same repository through the same backend.
    const other = service(env);
    expect((await other.readFile({ repo: 'svc', ref: 'main', path: 'a.md' }))?.content).toBe('a');
    expect((await other.listTree({ repo: 'svc', ref: 'main' }))?.entries).toHaveLength(1);
    expect(await other.resolveRef({ repo: 'svc', ref: 'main' })).not.toBeNull();
    expect((await other.log({ repo: 'svc', ref: 'main' })).commits).toHaveLength(1);
    const sha = (await other.resolveRef({ repo: 'svc', ref: 'main' }))?.sha ?? '';
    expect(await other.commitExists({ repo: 'svc', sha })).toEqual({ exists: true });
    expect((await other.promote({ repo: 'svc', from: 'main', into: 'staging', sha })).status).toBe(
      'promoted',
    );
    expect((await other.syncBranch({ repo: 'svc', from: 'main', into: 'staging' })).status).toBe(
      'up_to_date',
    );
    expect((await other.mintReadToken({ repo: 'svc' })).token).toMatch(/^ggr_/);
    expect(await other.deleteRepo({ repo: 'svc' })).toEqual({ deleted: true });
  });

  it('throws GatewayErrors whose body survives a transport that keeps only the message', async () => {
    const instance = service();
    const error: unknown = await instance.createRepo({ repo: 'bad/name' }).catch((thrown: unknown) => thrown);
    const crossed = new Error(error instanceof Error ? error.message : '');
    expect(readGatewayError(crossed)).toMatchObject({ code: 'invalid_input' });
  });

  it('refuses to start without a valid read-token secret', async () => {
    const instance = service({ backend: new MemoryBackend(), secret: 'short' });
    await expect(instance.createRepo({ repo: 'x' })).rejects.toThrow(
      /expected string to have >=32 characters/,
    );
  });

  it('keeps its options out of reach of RPC: nothing but the contract methods is on the class', () => {
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(service())).toSorted();
    expect(own).toEqual(
      [
        'commit',
        'commitExists',
        'constructor',
        'createRepo',
        'deleteRepo',
        'listTree',
        'log',
        'mintReadToken',
        'promote',
        'readFile',
        'resolveRef',
        'syncBranch',
      ].toSorted(),
    );
  });
});
