// SPDX-License-Identifier: Apache-2.0
import type { PushPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PushPolicyInput } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { PushPolicyResultInput } from '@leed-ai/git-gateway-contract/proxy/push-policy-result';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { createGatewayApp } from '@leed-ai/git-gateway-worker/gateway-app';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { testBinding } from './helpers/test-binding.ts';

// The Artifacts local simulator holds an exclusive per-repository lock for the whole of every git
// HTTP request and every binding call. A gateway that read the repository while its own
// receive-pack to it was still open would wait on that lock forever; these pushes complete only
// because every read is made before the push is opened.

const backend = new ArtifactsBackend({ binding: testBinding(env) });
const MAIN = 'refs/heads/main';
let repo = '';

afterEach(async () => {
  await backend.deleteRepo(repo);
});

/** A push policy that reads a file of the repository at the old tip and looks at the changed paths. */
class ConfigReadingPolicy implements PushPolicy {
  readonly seen: { config: string | null; paths: string[] }[] = [];

  needs() {
    return { changedPaths: true };
  }

  async check(input: PushPolicyInput): Promise<PushPolicyResultInput> {
    const refs = [];
    for (const update of input.updates) {
      const config = await backend.readFile(input.repo, update.oldSha, 'policy.txt');
      const paths = (update.commits ?? []).flatMap((commit) => commit.changes.map((change) => change.path));
      this.seen.push({ config: config === null ? null : new TextDecoder().decode(config), paths });
      const denied = paths.find((path) => path.startsWith('generated/'));
      refs.push(
        denied === undefined
          ? { ref: update.ref, decision: 'allow' as const }
          : { ref: update.ref, decision: 'deny' as const, reason: `generated/ is read-only: ${denied}` },
      );
    }
    return { refs };
  }
}

/** A gateway over the simulator whose branch policy keeps main fast-forward-only. */
async function gateway() {
  repo = `gw-${crypto.randomUUID().slice(0, 8)}`;
  await backend.createRepo(repo);
  const seed = await fixtureCommit({ 'policy.txt': 'deny generated/\n', 'docs/a.md': 'a\n' });
  const direct = new GitHttpClient(await backend.gitRemote(repo, 'write'));
  await direct.push([{ oldSha: ZERO_SHA, newSha: seed.sha, ref: MAIN }], seed.objects);
  const policy = new ConfigReadingPolicy();
  const app = createGatewayApp({
    backend,
    authenticator: { authenticate: async () => ({ subject: 'alice', roles: ['editor'] }) },
    authorizer: { authorize: async () => true },
    branchPolicy: {
      check: (_principal, _repo, updates) => ({
        refs: updates.map(({ ref }) => ({
          ref,
          decision: 'fast-forward-only' as const,
          reason: 'force pushes are not allowed',
        })),
      }),
    },
    pushPolicy: policy,
  });
  const client = new GitHttpClient(
    { url: `https://gateway.test/${repo}.git`, headers: { Authorization: `Basic ${btoa('git:x')}` } },
    { fetch: async (request) => app.fetch(request) },
  );
  const known = new Set(seed.objects.map((object) => object.sha));
  const pushEdit = async (files: Record<string, string>) => {
    const next = await fixtureCommit(files, [seed.sha]);
    const objects = next.objects.filter((object) => !known.has(object.sha));
    return { next, report: await client.push([{ oldSha: seed.sha, newSha: next.sha, ref: MAIN }], objects) };
  };
  return { policy, seed, pushEdit };
}

describe('gateway push with a push policy, on the Artifacts local simulator', () => {
  it('completes a fast-forward the policy checks by reading the repository', async () => {
    const { policy, pushEdit } = await gateway();
    const { next, report } = await pushEdit({
      'policy.txt': 'deny generated/\n',
      'docs/a.md': 'a, edited\n',
    });
    expect(report).toEqual({ unpack: 'ok', refs: [{ ref: MAIN, status: 'ok' }] });
    expect(policy.seen).toEqual([{ config: 'deny generated/\n', paths: ['docs/a.md'] }]);
    expect(await backend.resolveRef(repo, 'main')).toBe(next.sha);
  });

  it('refuses in-protocol what the policy denies, leaving the branch alone', async () => {
    const { seed, pushEdit } = await gateway();
    const { report } = await pushEdit({
      'policy.txt': 'deny generated/\n',
      'docs/a.md': 'a\n',
      'generated/out.js': 'built\n',
    });
    expect(report).toEqual({
      unpack: 'ok',
      refs: [{ ref: MAIN, status: 'ng', reason: 'generated/ is read-only: generated/out.js' }],
    });
    expect(await backend.resolveRef(repo, 'main')).toBe(seed.sha);
  });
});
