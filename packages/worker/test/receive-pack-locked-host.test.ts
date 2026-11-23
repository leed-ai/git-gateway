// SPDX-License-Identifier: Apache-2.0
import type { PushPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PushPolicyInput } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { PushPolicyResultInput } from '@leed-ai/git-gateway-contract/proxy/push-policy-result';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { policyGateway, REPO } from './helpers/policy-gateway.ts';
import { commitObject, pushBody } from './helpers/push-builder.ts';
import {
  push,
  pushObjects,
  receivePackFixture,
  report,
  type PushObjects,
} from './helpers/receive-pack-fixture.ts';
import { RepositoryLocks } from './helpers/repository-locks.ts';

// A storage host may serialise everything per repository — the Artifacts local simulator holds an
// exclusive lock for the whole of each git HTTP request and each binding call. Every storage read
// a push needs must therefore be made before the gateway opens its receive-pack to the host.

let o: PushObjects;
beforeAll(async () => {
  o = await pushObjects();
});

/**
 * A fast-forward-only push to main of `tip`, whose parent `mid` storage already has: proving it
 * walks out of the pack into storage.
 */
async function fastForwardThroughStorage(locks: RepositoryLocks) {
  const gateway = receivePackFixture(o, { locks });
  const mid = await commitObject([o.base.sha], 'mid');
  gateway.backend.addCommit(mid.sha, [o.base.sha]);
  const tip = await commitObject([mid.sha], 'tip');
  const body = await pushBody(
    [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: tip.sha }],
    [o.tree, tip],
  );
  return { ...gateway, body };
}

/** A push policy that reads a file of the repository at the old tip, as a config-driven policy does. */
class ConfigReadingPolicy implements PushPolicy {
  backend: StorageBackend | null = null;
  readonly configs: (string | null)[] = [];

  needs() {
    return { changedPaths: true };
  }

  async check(input: PushPolicyInput): Promise<PushPolicyResultInput> {
    const refs = [];
    for (const update of input.updates) {
      const config = await this.backend?.readFile(input.repo, update.oldSha, 'README.md');
      this.configs.push(config === null || config === undefined ? null : new TextDecoder().decode(config));
      refs.push({ ref: update.ref, decision: 'allow' as const });
    }
    return { refs };
  }
}

describe('receive-pack against a host that locks each repository', () => {
  it('proves a fast-forward from the pack and storage before the push is opened', async () => {
    const locks = new RepositoryLocks();
    const { app, upstream, body } = await fastForwardThroughStorage(locks);
    const result = await report(await push(app, 'alice-token', body));
    expect(locks.violations).toEqual([]);
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(upstream.last().body).toEqual(body);
  });

  it('asks isAncestor before the push is opened', async () => {
    const locks = new RepositoryLocks();
    const { app, backend, upstream, body } = await fastForwardThroughStorage(locks);
    backend.answerAncestry();
    const result = await report(await push(app, 'alice-token', body));
    expect(locks.violations).toEqual([]);
    expect(backend.ancestryQueries).toBe(1);
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(upstream.last().body).toEqual(body);
  });

  it('refuses a non-fast-forward without ever opening the push', async () => {
    const locks = new RepositoryLocks();
    const { app, upstream } = receivePackFixture(o, { locks });
    const body = await pushBody(
      [{ ref: 'refs/heads/main', oldSha: o.base.sha, newSha: o.unrelated.sha }],
      [o.tree, o.unrelated],
    );
    const result = await report(await push(app, 'alice-token', body));
    expect(result.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: 'main is protected' }]);
    expect(upstream.received).toEqual([]);
  });

  it('computes changed paths and runs a policy that reads the repository before the push is opened', async () => {
    const locks = new RepositoryLocks();
    const policy = new ConfigReadingPolicy();
    const gateway = await policyGateway(
      { 'README.md': '# Site\n', 'docs/a.md': 'a\n' },
      {},
      { locks, pushPolicy: policy },
    );
    policy.backend = locks.backend(gateway.backend);
    const next = await fixtureCommit({ 'README.md': '# Site\n', 'docs/a.md': 'a, edited\n' }, [
      gateway.seed.sha,
    ]);
    const known = new Set(gateway.seed.objects.map((object) => object.sha));
    const pushed = await gateway.pushTo(
      'refs/heads/main',
      gateway.seed.sha,
      next,
      next.objects.filter((object) => !known.has(object.sha)),
    );
    expect(locks.violations).toEqual([]);
    expect(pushed).toEqual({ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] });
    expect(policy.configs).toEqual(['# Site\n']);
    expect(await gateway.backend.resolveRef(REPO, 'main')).toBe(next.sha);
  });
});
