// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue } from '@leed-ai/git-gateway-contract/behaviour/assertions';
import { sameBytes } from '@leed-ai/git-gateway-contract/reference/bytes';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';

import { backendCase, type BackendCase } from './backend-case.ts';
import { fixtureCommit } from './backend-fixtures.ts';
import { expectAccepted, pushNewBranch, pushRef, seedRepo } from './push-helpers.ts';

const GROUP = 'transport';

const sortedShas = (objects: readonly { sha: string }[]): string[] =>
  objects.map((object) => object.sha).toSorted();

/** Empty repositories, gitRemote, push and fetch over the host's smart-HTTP remote. */
export const transportCases: readonly BackendCase[] = [
  backendCase(GROUP, 'an empty repository has no refs, no history and no files', async (context) => {
    const { backend, repo } = context;
    await backend.createRepo(repo);
    assertEqual(await backend.resolveRef(repo, 'main'), null, 'resolveRef');
    assertEqual(await backend.log(repo, 'main', { limit: 10 }), [], 'log');
    assertEqual(await backend.readFile(repo, 'main', 'README.md'), null, 'readFile');
    const reader = await context.client('read');
    assertEqual((await reader.advertisement('git-upload-pack')).refs, [], 'upload-pack advertises no refs');
    const writer = await context.client('write');
    assertEqual((await writer.advertisement('git-receive-pack')).refs, [], 'receive-pack advertises no refs');
  }),
  backendCase(GROUP, 'gitRemote mints a remote whose headers authorize it', async (context) => {
    await context.backend.createRepo(context.repo);
    for (const access of ['read', 'write'] as const) {
      const remote = await context.backend.gitRemote(context.repo, access);
      assertTrue(GitRemote.safeParse(remote).success, `${access} remote is a GitRemote`);
      assertTrue(remote.url.endsWith('.git'), `${access} remote URL ends in .git`);
      assertTrue(!remote.url.includes('@'), `${access} remote URL carries no credential`);
    }
  }),
  backendCase(GROUP, 'a push to an empty repository creates the branch', async (context) => {
    const seeded = await seedRepo(context);
    assertEqual(
      await context.backend.resolveRef(context.repo, 'main'),
      seeded.sha,
      'resolveRef sees the push',
    );
    const advertised = (await (await context.client('read')).advertisement('git-upload-pack')).refs;
    assertTrue(
      advertised.some((ref) => ref.name === 'refs/heads/main' && ref.sha === seeded.sha),
      'advertised',
    );
  }),
  backendCase(GROUP, 'a fetch returns every pushed object byte for byte', async (context) => {
    const seeded = await seedRepo(context, {
      'a.txt': 'a\n',
      'dir/b.txt': 'b\n',
      'dir/sub/c.bin': { content: new Uint8Array([0, 1, 2]) },
    });
    const fetched = await (await context.client('read')).fetchPack({ wants: [seeded.sha] });
    assertEqual(sortedShas(fetched.objects), sortedShas(seeded.objects), 'the same object ids');
    for (const object of seeded.objects) {
      const got = fetched.objects.find((candidate) => candidate.sha === object.sha);
      assertTrue(
        got?.type === object.type && sameBytes(got.data, object.data),
        `object ${object.sha} round-trips`,
      );
    }
  }),
  backendCase(GROUP, 'a fetch with haves leaves out what the client has', async (context) => {
    const first = await seedRepo(context);
    const second = await fixtureCommit({ 'README.md': '# Seed\n', 'new.txt': 'new\n' }, [first.sha]);
    expectAccepted(
      await pushRef(context, 'refs/heads/main', first.sha, second.sha, second.objects),
      'refs/heads/main',
    );
    const fetched = await (
      await context.client('read')
    ).fetchPack({ wants: [second.sha], haves: [first.sha] });
    const got = new Set(fetched.objects.map((object) => object.sha));
    assertTrue(got.has(second.sha), 'the new commit is sent');
    assertTrue(!got.has(first.sha), 'the had commit is not sent');
  }),
  backendCase(
    GROUP,
    'a second branch can point at an existing commit with an empty pack',
    async (context) => {
      const seeded = await seedRepo(context);
      expectAccepted(
        await pushRef(context, 'refs/heads/staging', ZERO_SHA, seeded.sha),
        'refs/heads/staging',
      );
      assertEqual(await context.backend.resolveRef(context.repo, 'staging'), seeded.sha, 'staging');
    },
  ),
  backendCase(GROUP, 'a read remote cannot push when the host scopes credentials', async (context) => {
    const seeded = await seedRepo(context);
    if (!context.behaviour.readRemoteCannotPush) return;
    const next = await fixtureCommit({ 'x.txt': 'x\n' }, [seeded.sha]);
    let pushed = false;
    try {
      const report = await (
        await context.client('read')
      ).push([{ oldSha: seeded.sha, newSha: next.sha, ref: 'refs/heads/main' }], next.objects);
      pushed = report.refs.every((ref) => ref.status === 'ok');
    } catch (error) {
      assertTrue(
        isCoreError(error, 'remote_error') || isCoreError(error, 'remote_http_error'),
        `refused by the remote, got ${String(error)}`,
      );
    }
    assertTrue(!pushed, 'the push did not succeed');
    assertEqual(await context.backend.resolveRef(context.repo, 'main'), seeded.sha, 'main unchanged');
  }),
  backendCase(
    GROUP,
    'pushes from new branches are visible to resolveRef and the advertisement',
    async (context) => {
      const seeded = await seedRepo(context);
      const feature = await fixtureCommit({ 'feature.txt': 'f\n' }, [seeded.sha]);
      await pushNewBranch(context, 'feature/one', feature);
      assertEqual(
        await context.backend.resolveRef(context.repo, 'refs/heads/feature/one'),
        feature.sha,
        'full ref',
      );
      const refs = (await (await context.client('write')).advertisement('git-receive-pack')).refs.map(
        (ref) => ref.name,
      );
      assertTrue(
        refs.includes('refs/heads/feature/one') && refs.includes('refs/heads/main'),
        'both branches advertised',
      );
    },
  ),
];
