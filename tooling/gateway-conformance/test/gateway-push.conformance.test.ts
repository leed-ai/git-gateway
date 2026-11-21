// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { PROTECTED_MESSAGE, startGatewayHarness, type GatewayHarness } from './gateway-harness.ts';

// The real git binary pushing through the gateway's branch policy, modelled on git's
// t5541-http-push-smart and t5516-fetch-push: fast-forwards, refused non-fast-forwards, force
// pushes allowed and denied, protected refs, branch create/delete and concurrent pushes.

let h: GatewayHarness;
let count = 0;

beforeAll(async () => {
  h = await startGatewayHarness();
});

afterAll(async () => h.close());

/** A new repository with one commit on main, and a clone of it as `who`. */
async function seeded(who: 'alice' | 'bob' = 'alice'): Promise<{ name: string; url: string; work: string }> {
  count += 1;
  const name = `pushing-${count}`;
  const url = await h.repo(name);
  const seed = h.sandbox.path(`${name}-seed`);
  expect((await h.git('alice', ['clone', '-q', url, seed])).status).toBe(0);
  await commit(seed, 'README.md', 'seed\n');
  expect((await h.git('alice', ['push', '-q', 'origin', 'main'], seed)).status).toBe(0);
  const work = h.sandbox.path(`${name}-${who}`);
  expect((await h.git(who, ['clone', '-q', url, work])).status).toBe(0);
  return { name, url, work };
}

async function commit(dir: string, file: string, content: string): Promise<string> {
  writeFileSync(`${dir}/${file}`, content);
  await h.sandbox.ok(['add', '-A'], { cwd: dir });
  await h.sandbox.ok(['commit', '-q', '-m', `${file}: ${content.trim()}`], { cwd: dir });
  return h.sandbox.ok(['rev-parse', 'HEAD'], { cwd: dir });
}

describe('pushing through the gateway with the git binary', () => {
  it('pushes a fast-forward', async () => {
    const repo = await seeded();
    const head = await commit(repo.work, 'a.txt', 'one');
    const pushed = await h.git('alice', ['push', 'origin', 'main'], repo.work);
    expect(pushed.status).toBe(0);
    expect(await h.backend.resolveRef(repo.name, 'main')).toBe(head);
  });

  it('has a non-fast-forward refused by git unless forced', async () => {
    const repo = await seeded();
    const before = await h.backend.resolveRef(repo.name, 'main');
    await h.sandbox.ok(['commit', '-q', '--amend', '-m', 'rewritten'], { cwd: repo.work });
    const pushed = await h.git('alice', ['push', 'origin', 'main'], repo.work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toMatch(/non-fast-forward|fetch first|\[rejected\]/);
    expect(await h.backend.resolveRef(repo.name, 'main')).toBe(before);
  });

  it('refuses a force push to the protected branch with the policy message', async () => {
    const repo = await seeded();
    const before = await h.backend.resolveRef(repo.name, 'main');
    await h.sandbox.ok(['commit', '-q', '--amend', '-m', 'rewritten'], { cwd: repo.work });
    const pushed = await h.git('alice', ['push', '--force', 'origin', 'main'], repo.work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain(`[remote rejected] main -> main (${PROTECTED_MESSAGE})`);
    expect(pushed.stderr).toContain(`remote: git-gateway: refs/heads/main: ${PROTECTED_MESSAGE}`);
    expect(await h.backend.resolveRef(repo.name, 'main')).toBe(before);
  });

  it('allows a force push where the policy allows it', async () => {
    const repo = await seeded();
    await h.sandbox.ok(['checkout', '-q', '-b', 'feature/x'], { cwd: repo.work });
    await commit(repo.work, 'f.txt', 'one');
    expect((await h.git('alice', ['push', '-q', 'origin', 'feature/x'], repo.work)).status).toBe(0);
    const rewritten = await h.sandbox
      .ok(['commit', '-q', '--amend', '-m', 'rewritten'], { cwd: repo.work })
      .then(async () => h.sandbox.ok(['rev-parse', 'HEAD'], { cwd: repo.work }));
    const forced = await h.git('alice', ['push', '--force', 'origin', 'feature/x'], repo.work);
    expect(forced.status).toBe(0);
    expect(await h.backend.resolveRef(repo.name, 'feature/x')).toBe(rewritten);
  });

  it('refuses a protected ref to a principal the rule does not name, with a readable message', async () => {
    const repo = await seeded('bob');
    const before = await h.backend.resolveRef(repo.name, 'main');
    await commit(repo.work, 'b.txt', 'bob');
    const pushed = await h.git('bob', ['push', 'origin', 'main'], repo.work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain(`[remote rejected] main -> main (${PROTECTED_MESSAGE})`);
    expect(await h.backend.resolveRef(repo.name, 'main')).toBe(before);
  });

  it('refuses every push from a read-only principal', async () => {
    const repo = await seeded();
    const pushed = await h.git('reader', ['push', 'origin', 'main:refs/heads/reader'], repo.work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toMatch(/remote error: access denied: reader may not push to pushing-/);
  });

  it('creates and deletes a branch, and refuses deleting the protected one', async () => {
    const repo = await seeded('bob');
    const created = await h.git('bob', ['push', 'origin', 'main:refs/heads/topic'], repo.work);
    expect(created.status).toBe(0);
    expect(await h.backend.resolveRef(repo.name, 'topic')).toBe(
      await h.backend.resolveRef(repo.name, 'main'),
    );
    expect((await h.git('bob', ['push', 'origin', '--delete', 'topic'], repo.work)).status).toBe(0);
    expect(await h.backend.resolveRef(repo.name, 'topic')).toBeNull();
    const deleting = await h.git('alice', ['push', 'origin', '--delete', 'main'], repo.work);
    expect(deleting.status).not.toBe(0);
    expect(deleting.stderr).toContain('[remote rejected] main');
    expect(await h.backend.resolveRef(repo.name, 'main')).not.toBeNull();
  });

  it('pushes tags but refuses moving one without force permission', async () => {
    const repo = await seeded();
    await h.sandbox.ok(['tag', 'v1'], { cwd: repo.work });
    expect((await h.git('alice', ['push', 'origin', 'v1'], repo.work)).status).toBe(0);
    await commit(repo.work, 't.txt', 'tag move');
    await h.sandbox.ok(['tag', '-f', 'v1'], { cwd: repo.work });
    const moved = await h.git('alice', ['push', '--force', 'origin', 'v1'], repo.work);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain('[remote rejected] v1 -> v1');
  });

  it('starts the main→staging SyncBranchWorkflow after a git push to main, and nothing for a refused one', async () => {
    const repo = await seeded();
    const head = await commit(repo.work, 'sync.txt', 'sync me');
    expect((await h.git('alice', ['push', '-q', 'origin', 'main'], repo.work)).status).toBe(0);
    const started = async () =>
      [...h.syncs.values()].filter((params) => params.repo === repo.name && params.fromHead === head);
    for (let wait = 0; wait < 50 && (await started()).length === 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await started()).toEqual([{ repo: repo.name, from: 'main', into: 'staging', fromHead: head }]);

    const before = h.syncs.size;
    await h.sandbox.ok(['commit', '-q', '--amend', '-m', 'rewritten'], { cwd: repo.work });
    expect((await h.git('alice', ['push', '--force', 'origin', 'main'], repo.work)).status).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.syncs.size).toBe(before);
  });

  it('refuses push options the storage host would act on with the gateway credential', async () => {
    const repo = await seeded('bob');
    await h.sandbox.ok(['checkout', '-q', '-b', 'feature/mr'], { cwd: repo.work });
    await commit(repo.work, 'mr.txt', 'merge me');
    const options = ['-o', 'merge_request.create', '-o', 'merge_request.target=main'];
    const pushed = await h.git('bob', ['push', ...options, 'origin', 'feature/mr'], repo.work);
    expect(pushed.status).not.toBe(0);
    const reason = 'push options "merge_request.create", "merge_request.target" not allowed by this gateway';
    expect(pushed.stderr).toContain(`[remote rejected] feature/mr -> feature/mr (${reason})`);
    expect(await h.backend.resolveRef(repo.name, 'feature/mr')).toBeNull();
    expect((await h.git('bob', ['push', '-q', 'origin', 'feature/mr'], repo.work)).status).toBe(0);
  });

  it('lets exactly one of two concurrent pushes to the same branch win', async () => {
    const repo = await seeded();
    const other = h.sandbox.path(`${repo.name}-other`);
    expect((await h.git('alice', ['clone', '-q', repo.url, other])).status).toBe(0);
    const first = await commit(repo.work, 'race.txt', 'first');
    const second = await commit(other, 'race.txt', 'second');
    const results = await Promise.all([
      h.git('alice', ['push', 'origin', 'main'], repo.work),
      h.git('alice', ['push', 'origin', 'main'], other),
    ]);
    const winners = results.filter((result) => result.status === 0);
    expect(winners.length).toBe(1);
    expect([first, second]).toContain(await h.backend.resolveRef(repo.name, 'main'));
    const loser = results.find((result) => result.status !== 0);
    expect(loser?.stderr).toMatch(/rejected|failed to (update|lock)|fetch first/);
  });
});
