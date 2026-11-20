// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '../schemas/sha.ts';
import { assertEqual, assertTrue, expectGatewayError, expectStatus } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { AUTHOR, commitActions, freshKey, readText, requireHead, seedRepo, writeFiles } from './fixtures.ts';

const GROUP = 'commit';

/** Branch creation, no-op detection, idempotency, stale-head refusal and attribution. */
export const commitWriteCases: readonly BehaviourCase[] = [
  behaviourCase(
    GROUP,
    'the first commit to an empty repository is a root commit',
    async ({ gateway, repo }) => {
      await gateway.createRepo({ repo });
      const output = await gateway.commit({
        repo,
        branch: 'main',
        message: 'Initial',
        author: AUTHOR,
        idempotencyKey: freshKey(),
        actions: [{ action: 'create', path: 'a.md', content: 'a' }],
      });
      const { commit, refUpdate } = expectStatus(output, 'committed');
      assertEqual(commit.parents, [], 'root commit has no parents');
      assertEqual(
        refUpdate,
        { ref: 'refs/heads/main', oldSha: ZERO_SHA, newSha: commit.sha },
        'branch created',
      );
      assertEqual(await requireHead(gateway, repo, 'main'), commit.sha, 'branch points at the commit');
    },
  ),
  behaviourCase(GROUP, 'a commit names its parent and moves the branch', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const output = await gateway.commit({
      repo,
      branch: 'main',
      message: 'Second',
      author: AUTHOR,
      idempotencyKey: freshKey(),
      actions: [{ action: 'create', path: 'b.md', content: 'b' }],
    });
    const { commit, refUpdate } = expectStatus(output, 'committed');
    assertEqual(commit.parents, [seed.sha], 'parent is the old head');
    assertEqual(refUpdate.oldSha, seed.sha, 'ref update names the old head');
    assertTrue(commit.tree !== seed.tree, 'tree changed');
  }),
  behaviourCase(GROUP, 'a missing branch is created from startBranch', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const commit = await writeFiles(gateway, repo, 'feature', { 'f.md': 'f' }, { startBranch: 'main' });
    assertEqual(commit.parents, [seed.sha], 'parent is the start branch head');
    assertEqual(await requireHead(gateway, repo, 'main'), seed.sha, 'start branch unchanged');
  }),
  behaviourCase(GROUP, 'startBranch is ignored when the branch exists', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const feature = await writeFiles(gateway, repo, 'feature', { 'f.md': 'f' }, { startBranch: 'main' });
    const next = await writeFiles(gateway, repo, 'feature', { 'g.md': 'g' }, { startBranch: 'main' });
    assertEqual(next.parents, [feature.sha], 'built on the existing branch');
  }),
  behaviourCase(GROUP, 'a missing branch without startBranch is ref_not_found', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const error = await expectGatewayError(
      writeFiles(gateway, repo, 'other', { 'x.md': 'x' }),
      'ref_not_found',
    );
    assertEqual(error.details.ref, 'other', 'names the branch');
  }),
  behaviourCase(GROUP, 'a missing startBranch is ref_not_found', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const call = writeFiles(gateway, repo, 'other', { 'x.md': 'x' }, { startBranch: 'nope' });
    assertEqual((await expectGatewayError(call, 'ref_not_found')).details.ref, 'nope', 'names startBranch');
  }),
  behaviourCase(GROUP, 'a commit that changes nothing is a noop', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, { 'a.md': 'same' });
    for (const actions of [
      [{ action: 'update' as const, path: 'a.md', content: 'same' }],
      [{ action: 'chmod' as const, path: 'a.md', executeFilemode: false }],
      [
        { action: 'create' as const, path: 'tmp.md', content: 't' },
        { action: 'delete' as const, path: 'tmp.md' },
      ],
    ]) {
      const output = await gateway.commit({
        repo,
        branch: 'main',
        message: 'noop',
        author: AUTHOR,
        idempotencyKey: freshKey(),
        actions,
      });
      assertEqual(output, { status: 'noop', head: seed.sha }, `noop for ${actions[0]?.action}`);
    }
    const log = await gateway.log({ repo, ref: 'main' });
    assertEqual(log.commits.length, 1, 'no commit written');
  }),
  behaviourCase(GROUP, 'a repeated idempotency key replays the first commit', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const key = freshKey('replay');
    const first = await writeFiles(gateway, repo, 'main', { 'a.md': '1' }, { idempotencyKey: key });
    const again = await gateway.commit({
      repo,
      branch: 'main',
      message: 'retry with other content',
      author: AUTHOR,
      idempotencyKey: key,
      actions: [{ action: 'upsert', path: 'a.md', content: '2' }],
    });
    assertEqual(again, { status: 'replayed', commit: first }, 'the earlier commit is returned');
    assertEqual(await readText(gateway, repo, 'main', 'a.md'), '1', 'nothing new written');
  }),
  behaviourCase(
    GROUP,
    'replay is found behind later commits and wins over a stale head',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo);
      const key = freshKey('replay');
      const first = await writeFiles(gateway, repo, 'main', { 'a.md': '1' }, { idempotencyKey: key });
      await writeFiles(gateway, repo, 'main', { 'b.md': '2' });
      const again = await gateway.commit({
        repo,
        branch: 'main',
        message: 'retry',
        author: AUTHOR,
        expectedHead: seed.sha,
        idempotencyKey: key,
        actions: [{ action: 'upsert', path: 'a.md', content: '1' }],
      });
      assertEqual(again, { status: 'replayed', commit: first }, 'replayed, not stale_head');
    },
  ),
  behaviourCase(GROUP, 'the idempotency key is recorded as a message trailer', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const key = freshKey('trailer');
    const commit = await writeFiles(
      gateway,
      repo,
      'main',
      { 'a.md': '1' },
      { idempotencyKey: key, message: 'Hello' },
    );
    assertEqual(commit.idempotencyKey, key, 'parsed key');
    assertTrue(commit.message.startsWith('Hello'), 'message kept');
    assertTrue(commit.message.includes(`Gateway-Idempotency-Key: ${key}`), 'trailer present');
  }),
  behaviourCase(GROUP, 'a stale expectedHead is refused with stale_head', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const moved = await writeFiles(gateway, repo, 'main', { 'a.md': '1' });
    const call = writeFiles(gateway, repo, 'main', { 'b.md': '2' }, { expectedHead: seed.sha });
    const error = await expectGatewayError(call, 'stale_head');
    assertEqual(error.details, { branch: 'main', expectedHead: seed.sha, actualHead: moved.sha }, 'details');
    assertEqual(await readText(gateway, repo, 'main', 'b.md'), null, 'nothing written');
  }),
  behaviourCase(GROUP, 'expectedHead null requires the branch not to exist', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const call = writeFiles(gateway, repo, 'main', { 'b.md': '2' }, { expectedHead: null });
    assertEqual((await expectGatewayError(call, 'stale_head')).details.actualHead, seed.sha, 'actual head');
    const created = await writeFiles(
      gateway,
      repo,
      'fresh',
      { 'c.md': '3' },
      { expectedHead: null, startBranch: 'main' },
    );
    assertEqual(created.parents, [seed.sha], 'new branch accepted with expectedHead null');
  }),
  behaviourCase(GROUP, 'a matching expectedHead commits', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    const commit = await writeFiles(gateway, repo, 'main', { 'a.md': '1' }, { expectedHead: seed.sha });
    assertEqual(commit.parents, [seed.sha], 'committed on the expected head');
  }),
  behaviourCase(GROUP, 'the committer defaults to the author and may be set', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo);
    assertEqual([seed.committer.name, seed.committer.email], [AUTHOR.name, AUTHOR.email], 'defaulted');
    const committer = { name: 'Robot', email: 'robot@example.com' };
    const commit = await writeFiles(gateway, repo, 'main', { 'a.md': '1' }, { committer });
    assertEqual([commit.author.name, commit.committer.name], [AUTHOR.name, 'Robot'], 'explicit committer');
  }),
  behaviourCase(GROUP, 'concurrent commits without expectedHead all land', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo);
    const outputs = await Promise.all(
      ['x', 'y', 'z'].map((name) =>
        commitActions(gateway, repo, 'main', [{ action: 'create', path: `${name}.md`, content: name }]),
      ),
    );
    assertEqual(new Set(outputs.map((commit) => commit.sha)).size, 3, 'three distinct commits');
    for (const name of ['x', 'y', 'z'])
      assertEqual(await readText(gateway, repo, 'main', `${name}.md`), name, name);
  }),
  behaviourCase(
    GROUP,
    'concurrent commits on the same expectedHead: exactly one wins',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo);
      const results = await Promise.allSettled(
        ['x', 'y'].map((name) =>
          writeFiles(gateway, repo, 'main', { [`${name}.md`]: name }, { expectedHead: seed.sha }),
        ),
      );
      assertEqual(results.filter((result) => result.status === 'fulfilled').length, 1, 'one commit lands');
      const rejected = results.find((result) => result.status === 'rejected');
      await expectGatewayError(Promise.reject(rejected?.reason), 'stale_head');
    },
  ),
];
