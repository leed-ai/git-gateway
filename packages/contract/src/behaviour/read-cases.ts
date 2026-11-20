// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, expectGatewayError, present } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { branchFrom, readText, seedRepo, writeFiles } from './fixtures.ts';

const GROUP = 'reads';
const SEED = { 'a.md': 'hello\n', 'dir/b.md': 'b', 'dir/sub/c.md': 'c', 'z.md': 'hello\n' };
const UNKNOWN_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

/** readFile, listTree, resolveRef, log and commitExists. */
export const readCases: readonly BehaviourCase[] = [
  behaviourCase(
    GROUP,
    'readFile returns content, git blob id, size, mode and commit',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo, SEED);
      const file = present(await gateway.readFile({ repo, ref: 'main', path: 'a.md' }), 'file exists');
      assertEqual(
        file,
        {
          path: 'a.md',
          commit: seed.sha,
          sha: 'ce013625030ba8dba906f756967f9e9ca394464a',
          size: 6,
          executable: false,
          encoding: 'text',
          content: 'hello\n',
        },
        'file read',
      );
      const twin = await gateway.readFile({ repo, ref: 'main', path: 'z.md' });
      assertEqual(twin?.sha, file.sha, 'equal content has an equal blob id');
    },
  ),
  behaviourCase(GROUP, 'readFile at an old commit reads the old content', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, SEED);
    await writeFiles(gateway, repo, 'main', { 'a.md': 'changed' });
    assertEqual(await readText(gateway, repo, seed.sha, 'a.md'), 'hello\n', 'old content by sha');
    assertEqual(await readText(gateway, repo, 'main', 'a.md'), 'changed', 'new content by branch');
  }),
  behaviourCase(GROUP, 'readFile is null for a missing path or a directory', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    assertEqual(await gateway.readFile({ repo, ref: 'main', path: 'nope.md' }), null, 'missing path');
    assertEqual(await gateway.readFile({ repo, ref: 'main', path: 'dir' }), null, 'directory');
  }),
  behaviourCase(GROUP, 'reads at a missing ref are ref_not_found', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await expectGatewayError(gateway.readFile({ repo, ref: 'nope', path: 'a.md' }), 'ref_not_found');
    await expectGatewayError(gateway.readFile({ repo, ref: UNKNOWN_SHA, path: 'a.md' }), 'ref_not_found');
    await expectGatewayError(gateway.listTree({ repo, ref: 'nope' }), 'ref_not_found');
    await expectGatewayError(gateway.log({ repo, ref: 'nope' }), 'ref_not_found');
  }),
  behaviourCase(
    GROUP,
    'listTree lists one level, sorted, with types and modes',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo, SEED);
      const root = present(await gateway.listTree({ repo, ref: 'main' }), 'root listing');
      assertEqual([root.commit, root.path], [seed.sha, null], 'listing header');
      assertEqual(
        root.entries.map((entry) => [entry.path, entry.name, entry.type, entry.mode]),
        [
          ['a.md', 'a.md', 'blob', '100644'],
          ['dir', 'dir', 'tree', '040000'],
          ['z.md', 'z.md', 'blob', '100644'],
        ],
        'root entries',
      );
      const dir = present(await gateway.listTree({ repo, ref: 'main', path: 'dir' }), 'dir listing');
      assertEqual(
        dir.entries.map((entry) => entry.path),
        ['dir/b.md', 'dir/sub'],
        'dir entries',
      );
    },
  ),
  behaviourCase(
    GROUP,
    'listTree recursive lists everything beneath, directories included',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      const listing = present(
        await gateway.listTree({ repo, ref: 'main', path: 'dir', recursive: true }),
        'listing',
      );
      assertEqual(
        listing.entries.map((entry) => entry.path),
        ['dir/b.md', 'dir/sub', 'dir/sub/c.md'],
        'entries',
      );
    },
  ),
  behaviourCase(GROUP, 'listTree is null for a file or a missing directory', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    assertEqual(await gateway.listTree({ repo, ref: 'main', path: 'a.md' }), null, 'file');
    assertEqual(await gateway.listTree({ repo, ref: 'main', path: 'nope' }), null, 'missing');
  }),
  behaviourCase(GROUP, 'an unchanged directory keeps its tree id', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, SEED);
    const next = await writeFiles(gateway, repo, 'main', { 'a.md': 'changed' });
    const dirSha = async (ref: string) =>
      (await gateway.listTree({ repo, ref }))?.entries.find((entry) => entry.path === 'dir')?.sha;
    assertEqual(await dirSha(next.sha), await dirSha(seed.sha), 'dir tree id unchanged');
    assertTrue(next.tree !== seed.tree, 'root tree id changed');
  }),
  behaviourCase(GROUP, 'resolveRef resolves branches and confirms commit ids', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, SEED);
    assertEqual(await gateway.resolveRef({ repo, ref: 'main' }), { sha: seed.sha }, 'branch');
    assertEqual(await gateway.resolveRef({ repo, ref: seed.sha }), { sha: seed.sha }, 'commit id');
    assertEqual(await gateway.resolveRef({ repo, ref: 'nope' }), null, 'missing branch');
    assertEqual(await gateway.resolveRef({ repo, ref: UNKNOWN_SHA }), null, 'unknown commit');
  }),
  behaviourCase(
    GROUP,
    'log lists newest first and pages with limit, offset and hasMore',
    async ({ gateway, repo }) => {
      const first = await seedRepo(gateway, repo, SEED);
      const second = await writeFiles(gateway, repo, 'main', { 'n.md': '2' });
      const third = await writeFiles(gateway, repo, 'main', { 'n.md': '3' });
      const all = await gateway.log({ repo, ref: 'main' });
      assertEqual(
        all.commits.map((c) => c.sha),
        [third.sha, second.sha, first.sha],
        'newest first',
      );
      assertEqual(all.hasMore, false, 'no more');
      const page = await gateway.log({ repo, ref: 'main', limit: 1, offset: 1 });
      assertEqual([page.commits.map((c) => c.sha), page.hasMore], [[second.sha], true], 'second page');
      const atSha = await gateway.log({ repo, ref: second.sha });
      assertEqual(
        atSha.commits.map((c) => c.sha),
        [second.sha, first.sha],
        'log from a commit id',
      );
    },
  ),
  behaviourCase(GROUP, 'log since keeps commits at or after the time', async ({ gateway, repo }) => {
    const first = await seedRepo(gateway, repo, SEED);
    const second = await writeFiles(gateway, repo, 'main', { 'n.md': '2' });
    const since = (date: string) => gateway.log({ repo, ref: 'main', since: date });
    assertEqual((await since('2000-01-01T00:00:00.000Z')).commits.length, 2, 'all after the distant past');
    assertEqual((await since('2999-01-01T00:00:00.000Z')).commits, [], 'none after the far future');
    const fromSecond = (await since(second.committer.date)).commits.map((c) => c.sha);
    assertTrue(fromSecond.includes(second.sha), 'a commit at exactly `since` is kept');
    assertTrue(first.committer.date <= second.committer.date, 'dates never go backwards');
  }),
  behaviourCase(
    GROUP,
    'log of a merge lists both sides, children before parents',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo, SEED);
      const side = await branchFrom(gateway, repo, 'main', 'side', { 's.md': 's' });
      const mainline = await writeFiles(gateway, repo, 'main', { 'm.md': 'm' });
      await gateway.syncBranch({ repo, from: 'side', into: 'main' });
      const shas = (await gateway.log({ repo, ref: 'main' })).commits.map((c) => c.sha);
      assertEqual(shas.length, 4, 'merge, both sides and the seed');
      assertEqual(shas.at(-1), seed.sha, 'root last');
      assertTrue(shas.includes(side.sha) && shas.includes(mainline.sha), 'both sides listed');
    },
  ),
  behaviourCase(
    GROUP,
    'commitExists checks the repository and, optionally, a branch',
    async ({ gateway, repo }) => {
      const seed = await seedRepo(gateway, repo, SEED);
      const side = await branchFrom(gateway, repo, 'main', 'side', { 's.md': 's' });
      const exists = async (sha: string, branch?: string) =>
        (await gateway.commitExists({ repo, sha, ...(branch === undefined ? {} : { branch }) })).exists;
      assertEqual(await exists(side.sha), true, 'any commit');
      assertEqual(await exists(UNKNOWN_SHA), false, 'unknown commit');
      assertEqual(await exists(seed.sha, 'side'), true, 'ancestor is reachable');
      assertEqual(await exists(side.sha, 'main'), false, 'not on main');
      assertEqual(await exists(seed.sha, 'nope'), false, 'missing branch');
    },
  ),
];
