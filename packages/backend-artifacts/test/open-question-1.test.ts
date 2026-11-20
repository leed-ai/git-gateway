// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { ArtifactsBackend } from '../src/artifacts-backend.ts';
import { testBinding } from './helpers/test-binding.ts';

// Spec open question 1, answered against the Artifacts server (the local simulator here; the
// live leg of the contract suite repeats it on the deployed service): does Artifacts refuse a
// receive-pack update whose old id is stale, and how does it treat a non-fast-forward update sent
// without --force? (The force flag never reaches the server: git's client refuses a
// non-fast-forward before pushing unless forced, so the server only ever sees old id and new id.)

const backend = new ArtifactsBackend({ binding: testBinding(env) });
const MAIN = 'refs/heads/main';
let repo = '';

afterEach(async () => {
  await backend.deleteRepo(repo);
});

async function seeded(): Promise<{ client: GitHttpClient; first: string; second: string }> {
  repo = `oq1-${crypto.randomUUID().slice(0, 8)}`;
  await backend.createRepo(repo);
  const client = new GitHttpClient(await backend.gitRemote(repo, 'write'));
  const first = await fixtureCommit({ 'a.txt': 'one\n' });
  await client.push([{ oldSha: ZERO_SHA, newSha: first.sha, ref: MAIN }], first.objects);
  const second = await fixtureCommit({ 'a.txt': 'two\n' }, [first.sha]);
  await client.push([{ oldSha: first.sha, newSha: second.sha, ref: MAIN }], second.objects);
  return { client, first: first.sha, second: second.sha };
}

describe('spec open question 1 (Artifacts receive-pack semantics)', () => {
  it('refuses an update whose old id is stale with "failed to update ref", leaving the ref alone', async () => {
    const { client, first, second } = await seeded();
    const stale = await fixtureCommit({ 'a.txt': 'stale\n' }, [first]);
    const report = await client.push([{ oldSha: first, newSha: stale.sha, ref: MAIN }], stale.objects);
    expect(report).toEqual({
      unpack: 'ok',
      refs: [{ ref: MAIN, status: 'ng', reason: 'failed to update ref' }],
    });
    expect(await backend.resolveRef(repo, 'main')).toBe(second);
  });

  it('accepts a non-fast-forward update whose old id is current (no denyNonFastForwards)', async () => {
    const { client, first, second } = await seeded();
    const rewrite = await fixtureCommit({ 'a.txt': 'rewritten\n' }, [first]);
    const report = await client.push([{ oldSha: second, newSha: rewrite.sha, ref: MAIN }], rewrite.objects);
    expect(report).toEqual({ unpack: 'ok', refs: [{ ref: MAIN, status: 'ok' }] });
    expect(await backend.resolveRef(repo, 'main')).toBe(rewrite.sha);
  });

  it('refuses creating a ref that exists (old id all zeros)', async () => {
    const { client, second } = await seeded();
    const other = await fixtureCommit({ 'b.txt': 'b\n' });
    const report = await client.push([{ oldSha: ZERO_SHA, newSha: other.sha, ref: MAIN }], other.objects);
    expect(report.refs[0]?.status).toBe('ng');
    expect(await backend.resolveRef(repo, 'main')).toBe(second);
  });
});
