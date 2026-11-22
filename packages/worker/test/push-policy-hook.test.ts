// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import {
  fixtureCommit,
  pseudoRandomBytes,
} from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { describe, expect, it } from 'vite-plus/test';

import { policyGateway, REPO } from './helpers/policy-gateway.ts';
import { pushBody } from './helpers/push-builder.ts';

const README = '# Site\n';

describe('push policy hook', () => {
  it('gives the policy every new commit with its changed paths, modes, ids and sizes', async () => {
    const { pushTo, policy, seed, head } = await policyGateway();
    const next = await fixtureCommit(
      { 'README.md': '# Site, revised\n', 'docs/a.md': 'A\n' },
      [seed.sha],
      'Docs\n',
    );
    const report = await pushTo('refs/heads/main', seed.sha, next);
    expect(report.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(await head()).toBe(next.sha);
    expect(policy.inputs).toHaveLength(1);
    const [update] = policy.inputs[0]?.updates ?? [];
    expect(update).toMatchObject({ ref: 'refs/heads/main', oldSha: seed.sha, newSha: next.sha });
    expect(update?.commits).toEqual([
      {
        sha: next.sha,
        parents: [seed.sha],
        changes: [
          {
            path: 'README.md',
            change: 'modified',
            oldMode: '100644',
            newMode: '100644',
            oldSha: expect.any(String),
            newSha: expect.any(String),
            size: 16,
          },
          {
            path: 'docs/a.md',
            change: 'added',
            oldMode: null,
            newMode: '100644',
            oldSha: null,
            newSha: expect.any(String),
            size: 2,
          },
        ],
      },
    ]);
    expect(policy.inputs[0]?.principal.subject).toBe('alice');
  });

  it('refuses a push the policy denies, in-protocol, and storage keeps its ref', async () => {
    const { pushTo, seed, head } = await policyGateway();
    const next = await fixtureCommit({ 'README.md': README, 'generated/site.css': 'x{}\n' }, [seed.sha]);
    const report = await pushTo('refs/heads/main', seed.sha, next);
    expect(report).toEqual({
      unpack: 'ok',
      refs: [
        {
          ref: 'refs/heads/main',
          status: 'ng',
          reason: 'generated/ is written by the build: generated/site.css',
        },
      ],
    });
    expect(await head()).toBe(seed.sha);
  });

  it('checks every commit the update brings, not just the net change', async () => {
    const { pushTo, seed, head } = await policyGateway();
    const large = await fixtureCommit(
      { 'README.md': README, 'big.bin': { content: pseudoRandomBytes(5000) } },
      [seed.sha],
    );
    const removed = await fixtureCommit({ 'README.md': README }, [large.sha], 'Remove it again\n');
    const report = await pushTo('refs/heads/main', seed.sha, removed, [...large.objects, ...removed.objects]);
    expect(report.refs[0]).toEqual({
      ref: 'refs/heads/main',
      status: 'ng',
      reason: 'files over 1000 bytes: big.bin',
    });
    expect(await head()).toBe(seed.sha);
  });

  it('gives a merge only the paths that differ from every parent', async () => {
    const { pushTo, policy, seed } = await policyGateway();
    const left = await fixtureCommit({ 'README.md': README, 'l.md': 'L\n' }, [seed.sha]);
    const right = await fixtureCommit({ 'README.md': README, 'r.md': 'R\n' }, [seed.sha]);
    const merge = await fixtureCommit({ 'README.md': README, 'l.md': 'L\n', 'r.md': 'R\n', 'm.md': 'M\n' }, [
      left.sha,
      right.sha,
    ]);
    const report = await pushTo('refs/heads/main', seed.sha, merge, [
      ...left.objects,
      ...right.objects,
      ...merge.objects,
    ]);
    expect(report.refs[0]?.status).toBe('ok');
    const commits = policy.inputs[0]?.updates[0]?.commits ?? [];
    expect(commits.map((commit) => commit.sha)).toEqual([merge.sha, left.sha, right.sha]);
    expect(commits[0]?.changes.map((change) => change.path)).toEqual(['m.md']);
    expect(commits[1]?.changes.map((change) => change.path)).toEqual(['l.md']);
  });

  it('decides before the pack when the policy needs no paths, and nothing reaches storage on a refusal', async () => {
    const { pushTo, client, policy, seed, head } = await policyGateway();
    policy.paths = false;
    const next = await fixtureCommit({ 'README.md': README, 'generated/x': 'x\n' }, [seed.sha]);
    expect((await pushTo('refs/heads/keep', ZERO_SHA, next)).refs[0]?.status).toBe('ok');
    expect(policy.inputs[0]?.updates[0]?.commits).toBeNull();
    const deleted = await client.push([{ ref: 'refs/heads/keep', oldSha: next.sha, newSha: ZERO_SHA }], []);
    expect(deleted.refs[0]).toEqual({ ref: 'refs/heads/keep', status: 'ng', reason: 'keep stays' });
    expect(await head('keep')).toBe(next.sha);
    expect(await head()).toBe(seed.sha);
  });

  it('checks a push of deletions only before forwarding it, with no commits', async () => {
    const { pushTo, client, policy, seed, head } = await policyGateway();
    await pushTo('refs/heads/keep', ZERO_SHA, seed);
    const deleted = await client.push([{ ref: 'refs/heads/keep', oldSha: seed.sha, newSha: ZERO_SHA }], []);
    expect(deleted.refs[0]).toEqual({ ref: 'refs/heads/keep', status: 'ng', reason: 'keep stays' });
    expect(policy.inputs.at(-1)?.updates[0]?.commits).toEqual([]);
    expect(await head('keep')).toBe(seed.sha);
  });

  it('refuses a push it cannot check within the read budget, saying why', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`d${index}/f.md`, `${index}\n`]),
    );
    const { pushTo, seed, head } = await policyGateway(files, { maxPushPolicyReads: 1 });
    // Moving every directory under a new parent re-uses trees storage has: one read each.
    const moved = await fixtureCommit(
      Object.fromEntries(Object.entries(files).map(([path, content]) => [`moved/${path}`, content])),
      [seed.sha],
    );
    const objects = moved.objects.filter((object) => !seed.objects.some((known) => known.sha === object.sha));
    const report = await pushTo('refs/heads/main', seed.sha, moved, objects);
    expect(report.refs[0]).toMatchObject({
      status: 'ng',
      reason: expect.stringMatching(/could not check this push: .*storage reads/),
    });
    expect(await head()).toBe(seed.sha);
  });

  it('refuses a pack larger than maxPushPolicyPackBytes before it completes', async () => {
    const { pushTo, seed, head } = await policyGateway(undefined, { maxPushPolicyPackBytes: 1024 * 1024 });
    const huge = await fixtureCommit(
      { 'README.md': README, 'huge.bin': { content: pseudoRandomBytes(1_200_000) } },
      [seed.sha],
    );
    const report = await pushTo('refs/heads/main', seed.sha, huge);
    expect(report.refs[0]).toMatchObject({
      status: 'ng',
      reason: expect.stringMatching(/pack is larger than 1048576 bytes/),
    });
    expect(await head()).toBe(seed.sha);
  });

  it('refuses in-protocol when check throws, and answers 503 when needs throws', async () => {
    const { pushTo, policy, seed, head, app } = await policyGateway();
    policy.failCheck = true;
    const next = await fixtureCommit({ 'README.md': '# changed\n' }, [seed.sha]);
    expect((await pushTo('refs/heads/main', seed.sha, next)).refs[0]).toMatchObject({
      status: 'ng',
      reason: 'the push could not be checked; try again later',
    });
    expect(await head()).toBe(seed.sha);
    policy.failNeeds = true;
    const response = await app.request(`/${REPO}.git/git-receive-pack`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa('git:x')}` },
      body: await pushBody([{ ref: 'refs/heads/main', oldSha: seed.sha, newSha: next.sha }], next.objects),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/push policy is unavailable/);
    expect(await head()).toBe(seed.sha);
  });
});
