// SPDX-License-Identifier: Apache-2.0
import type { PushPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PushPolicyInput } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { PushPolicyResultInput } from '@leed-ai/git-gateway-contract/proxy/push-policy-result';
import type { SmartHttpConfigInput } from '@leed-ai/git-gateway-contract/proxy/smart-http-config';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import {
  fixtureCommit,
  type FixtureCommit,
} from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';

import { createGatewayApp } from '../../src/gateway-app.ts';
import type { LogEntry } from '../../src/logging/logger.ts';
import { basic } from './gateway-fixture.ts';
import type { RepositoryLocks } from './repository-locks.ts';

export const REPO = 'site';

/**
 * The example policy the tests run: nothing under generated/ may change, and no file may be
 * larger than `maxFileBytes`. It asks for changed paths unless `paths` is false, and records
 * every input it is given.
 */
export class ExamplePolicy implements PushPolicy {
  readonly inputs: PushPolicyInput[] = [];
  paths = true;
  maxFileBytes = 1000;
  failCheck = false;
  failNeeds = false;

  needs() {
    if (this.failNeeds) throw new Error('policy store down');
    return { changedPaths: this.paths };
  }

  check(input: PushPolicyInput): PushPolicyResultInput {
    if (this.failCheck) throw new Error('policy store down');
    this.inputs.push(input);
    return {
      refs: input.updates.map((update) => {
        const changes = (update.commits ?? []).flatMap((commit) => commit.changes);
        const generated = changes.find((change) => change.path.startsWith('generated/'));
        if (generated !== undefined)
          return {
            ref: update.ref,
            decision: 'deny',
            reason: `generated/ is written by the build: ${generated.path}`,
          };
        const large = changes.find((change) => (change.size ?? 0) > this.maxFileBytes);
        if (large !== undefined)
          return {
            ref: update.ref,
            decision: 'deny',
            reason: `files over ${this.maxFileBytes} bytes: ${large.path}`,
          };
        if (update.newSha === ZERO_SHA && update.ref === 'refs/heads/keep')
          return { ref: update.ref, decision: 'deny', reason: 'keep stays' };
        return { ref: update.ref, decision: 'allow' };
      }),
    };
  }
}

/**
 * A gateway over an in-memory backend (a real receive-pack host) whose branch policy allows
 * everything and whose push policy is an {@link ExamplePolicy}; `main` is seeded with `files`.
 */
export async function policyGateway(
  files: Record<string, string> = { 'README.md': '# Site\n' },
  smartHttp: SmartHttpConfigInput = {},
  options: { readonly locks?: RepositoryLocks; readonly pushPolicy?: PushPolicy } = {},
) {
  const backend = new MemoryBackend();
  await backend.createRepo(REPO, { defaultBranch: 'main' });
  const seed = await fixtureCommit(files, [], 'Seed\n');
  const direct = new GitHttpClient(await backend.gitRemote(REPO, 'write'), { fetch: backend.fetch });
  await direct.push([{ ref: 'refs/heads/main', oldSha: ZERO_SHA, newSha: seed.sha }], seed.objects);
  const policy = new ExamplePolicy();
  const logs: LogEntry[] = [];
  const app = createGatewayApp({
    backend: options.locks ? options.locks.backend(backend) : backend,
    authenticator: { authenticate: async () => ({ subject: 'alice', roles: ['editor'] }) },
    authorizer: { authorize: async () => true },
    branchPolicy: {
      check: (_principal, _repo, updates) => ({
        refs: updates.map(({ ref }) => ({ ref, decision: 'allow' as const })),
      }),
    },
    pushPolicy: options.pushPolicy ?? policy,
    logger: { log: (entry) => logs.push(entry) },
    smartHttp,
    fetch: options.locks ? options.locks.fetch(backend.fetch) : backend.fetch,
  });
  const client = new GitHttpClient(
    { url: `https://gateway.test/${REPO}.git`, headers: basic('alice-token') },
    { fetch: async (request) => app.fetch(request) },
  );
  const pushTo = async (
    ref: string,
    oldSha: string,
    commit: FixtureCommit,
    objects: readonly GitObject[] = commit.objects,
  ) => client.push([{ ref, oldSha, newSha: commit.sha }], objects);
  return {
    backend,
    app,
    client,
    policy,
    seed,
    logs,
    pushTo,
    head: async (ref = 'main') => backend.resolveRef(REPO, ref),
  };
}
