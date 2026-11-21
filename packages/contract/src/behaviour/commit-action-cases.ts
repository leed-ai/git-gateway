// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, expectGatewayError } from './assertions.ts';
import { behaviourCase, type BehaviourCase } from './behaviour-case.ts';
import { AUTHOR, commitActions, filePaths, freshKey, readText, requireHead, seedRepo } from './fixtures.ts';

const GROUP = 'commit actions';
/** git's id for the empty blob. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const SEED = { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n', 'top.txt': 'top\n' };

/** Every rule of the commit-action table: create, update, upsert, delete, move, chmod. */
export const commitActionCases: readonly BehaviourCase[] = [
  behaviourCase(GROUP, 'create adds a new file', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [{ action: 'create', path: 'docs/c.md', content: 'c\n' }]);
    assertEqual(await readText(gateway, repo, 'main', 'docs/c.md'), 'c\n', 'created file content');
  }),
  behaviourCase(GROUP, 'create fails with path_exists when the file exists', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const error = await expectGatewayError(
      commitActions(gateway, repo, 'main', [{ action: 'create', path: 'docs/a.md', content: 'x' }]),
      'path_exists',
    );
    assertEqual(error.details.path, 'docs/a.md', 'path_exists names the path');
  }),
  behaviourCase(
    GROUP,
    'create fails with path_exists when the path is a directory',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await expectGatewayError(
        commitActions(gateway, repo, 'main', [{ action: 'create', path: 'docs', content: 'x' }]),
        'path_exists',
      );
    },
  ),
  behaviourCase(GROUP, 'create fails with path_conflict beneath a file', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const error = await expectGatewayError(
      commitActions(gateway, repo, 'main', [{ action: 'create', path: 'top.txt/inner.md', content: 'x' }]),
      'path_conflict',
    );
    assertEqual(error.details, { path: 'top.txt/inner.md', conflictingPath: 'top.txt' }, 'conflict details');
  }),
  behaviourCase(GROUP, 'update replaces an existing file', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [{ action: 'update', path: 'docs/a.md', content: 'A\n' }]);
    assertEqual(await readText(gateway, repo, 'main', 'docs/a.md'), 'A\n', 'updated content');
  }),
  behaviourCase(
    GROUP,
    'update fails with path_not_found when the file is absent',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      const error = await expectGatewayError(
        commitActions(gateway, repo, 'main', [{ action: 'update', path: 'docs/zz.md', content: 'x' }]),
        'path_not_found',
      );
      assertEqual(error.details.path, 'docs/zz.md', 'path_not_found names the path');
    },
  ),
  behaviourCase(GROUP, 'update fails with path_not_found on a directory', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await expectGatewayError(
      commitActions(gateway, repo, 'main', [{ action: 'update', path: 'docs', content: 'x' }]),
      'path_not_found',
    );
  }),
  behaviourCase(
    GROUP,
    'upsert creates a missing file and replaces an existing one',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await commitActions(gateway, repo, 'main', [
        { action: 'upsert', path: 'docs/new.md', content: 'new\n' },
        { action: 'upsert', path: 'docs/a.md', content: 'replaced\n' },
      ]);
      assertEqual(await readText(gateway, repo, 'main', 'docs/new.md'), 'new\n', 'upsert created');
      assertEqual(await readText(gateway, repo, 'main', 'docs/a.md'), 'replaced\n', 'upsert replaced');
    },
  ),
  behaviourCase(GROUP, 'upsert fails with path_exists on a directory', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await expectGatewayError(
      commitActions(gateway, repo, 'main', [{ action: 'upsert', path: 'docs', content: 'x' }]),
      'path_exists',
    );
  }),
  behaviourCase(GROUP, 'delete removes a file and empty directories vanish', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, { 'only/one.md': '1', 'keep.md': 'k' });
    await commitActions(gateway, repo, 'main', [{ action: 'delete', path: 'only/one.md' }]);
    assertEqual(await filePaths(gateway, repo, 'main'), ['keep.md'], 'remaining files');
    assertEqual(await gateway.listTree({ repo, ref: 'main', path: 'only' }), null, 'empty directory is gone');
  }),
  behaviourCase(
    GROUP,
    'delete fails with path_not_found when the file is absent',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await expectGatewayError(
        commitActions(gateway, repo, 'main', [{ action: 'delete', path: 'nope.md' }]),
        'path_not_found',
      );
    },
  ),
  behaviourCase(GROUP, 'move renames a file, keeping content and mode', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [
      { action: 'chmod', path: 'top.txt', executeFilemode: true },
      { action: 'move', previousPath: 'top.txt', path: 'bin/top.sh' },
    ]);
    const moved = await gateway.readFile({ repo, ref: 'main', path: 'bin/top.sh' });
    assertEqual(moved?.content, 'top\n', 'content kept');
    assertEqual(moved?.executable, true, 'executable bit kept');
    assertEqual(await readText(gateway, repo, 'main', 'top.txt'), null, 'old path gone');
  }),
  behaviourCase(GROUP, 'move with content replaces the content', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [
      { action: 'move', previousPath: 'docs/a.md', path: 'docs/a2.md', content: 'moved\n' },
    ]);
    assertEqual(await readText(gateway, repo, 'main', 'docs/a2.md'), 'moved\n', 'new content');
  }),
  behaviourCase(
    GROUP,
    'move fails with path_not_found when previousPath is absent',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      const error = await expectGatewayError(
        commitActions(gateway, repo, 'main', [{ action: 'move', previousPath: 'gone.md', path: 'x.md' }]),
        'path_not_found',
      );
      assertEqual(error.details.path, 'gone.md', 'names previousPath');
    },
  ),
  behaviourCase(GROUP, 'move fails with path_exists when path exists', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await expectGatewayError(
      commitActions(gateway, repo, 'main', [
        { action: 'move', previousPath: 'docs/a.md', path: 'docs/b.md' },
      ]),
      'path_exists',
    );
  }),
  behaviourCase(GROUP, 'move may place a file beneath its own old path', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [
      { action: 'move', previousPath: 'top.txt', path: 'top.txt/x' },
    ]);
    assertEqual(await readText(gateway, repo, 'main', 'top.txt/x'), 'top\n', 'moved beneath old path');
  }),
  behaviourCase(GROUP, 'chmod sets and clears the executable bit', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [{ action: 'chmod', path: 'top.txt', executeFilemode: true }]);
    const listing = await gateway.listTree({ repo, ref: 'main' });
    const entry = listing?.entries.find((candidate) => candidate.path === 'top.txt');
    assertEqual(entry?.mode, '100755', 'mode after setting');
    await commitActions(gateway, repo, 'main', [
      { action: 'chmod', path: 'top.txt', executeFilemode: false },
    ]);
    assertEqual(
      (await gateway.readFile({ repo, ref: 'main', path: 'top.txt' }))?.executable,
      false,
      'cleared',
    );
  }),
  behaviourCase(
    GROUP,
    'chmod fails with path_not_found when the file is absent',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await expectGatewayError(
        commitActions(gateway, repo, 'main', [{ action: 'chmod', path: 'nope', executeFilemode: true }]),
        'path_not_found',
      );
    },
  ),
  behaviourCase(GROUP, 'update keeps the executable bit', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    await commitActions(gateway, repo, 'main', [
      { action: 'chmod', path: 'top.txt', executeFilemode: true },
      { action: 'update', path: 'top.txt', content: 'changed\n' },
    ]);
    assertEqual((await gateway.readFile({ repo, ref: 'main', path: 'top.txt' }))?.executable, true, 'kept');
  }),
  behaviourCase(
    GROUP,
    'actions apply in order, each to the result of the one before',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await commitActions(gateway, repo, 'main', [
        { action: 'create', path: 'seq.md', content: '1' },
        { action: 'update', path: 'seq.md', content: '2' },
        { action: 'move', previousPath: 'seq.md', path: 'seq2.md' },
      ]);
      assertEqual(await readText(gateway, repo, 'main', 'seq2.md'), '2', 'final state of the sequence');
    },
  ),
  behaviourCase(GROUP, 'a failing action writes nothing at all', async ({ gateway, repo }) => {
    const seed = await seedRepo(gateway, repo, SEED);
    await expectGatewayError(
      commitActions(gateway, repo, 'main', [
        { action: 'create', path: 'fresh.md', content: 'x' },
        { action: 'delete', path: 'missing.md' },
      ]),
      'path_not_found',
    );
    assertEqual(await requireHead(gateway, repo, 'main'), seed.sha, 'head unchanged');
    assertEqual(await readText(gateway, repo, 'main', 'fresh.md'), null, 'earlier action not applied');
  }),
  behaviourCase(GROUP, 'base64 content round-trips binary bytes', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const binary = '/wD+AQ==';
    await commitActions(gateway, repo, 'main', [
      { action: 'create', path: 'bin.dat', content: binary, encoding: 'base64' },
    ]);
    const asText = await gateway.readFile({ repo, ref: 'main', path: 'bin.dat', encoding: 'text' });
    assertEqual(
      [asText?.encoding, asText?.content, asText?.size],
      ['base64', binary, 4],
      'non-UTF-8 → base64',
    );
    const asBase64 = await gateway.readFile({ repo, ref: 'main', path: 'top.txt', encoding: 'base64' });
    assertEqual([asBase64?.encoding, asBase64?.content], ['base64', 'dG9wCg=='], 'base64 on request');
  }),
  behaviourCase(GROUP, 'invalid base64 content is refused as invalid_input', async ({ gateway, repo }) => {
    await seedRepo(gateway, repo, SEED);
    const call = gateway.commit({
      repo,
      branch: 'main',
      message: 'bad',
      author: AUTHOR,
      idempotencyKey: freshKey(),
      actions: [{ action: 'create', path: 'x.bin', content: 'not base64!', encoding: 'base64' }],
    });
    const error = await expectGatewayError(call, 'invalid_input');
    assertTrue(error.details.issues.length > 0, 'issues listed');
  }),
  behaviourCase(
    GROUP,
    'unicode paths, unicode text and empty files round-trip',
    async ({ gateway, repo }) => {
      await seedRepo(gateway, repo, SEED);
      await commitActions(gateway, repo, 'main', [
        { action: 'create', path: 'données/résumé ✓.md', content: 'héllo 🌍\n' },
        { action: 'create', path: 'empty.txt', content: '' },
      ]);
      assertEqual(await readText(gateway, repo, 'main', 'données/résumé ✓.md'), 'héllo 🌍\n', 'unicode');
      const empty = await gateway.readFile({ repo, ref: 'main', path: 'empty.txt' });
      assertEqual([empty?.content, empty?.size, empty?.sha], ['', 0, EMPTY_BLOB], 'empty file');
    },
  ),
];
