// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, present } from '@leed-ai/git-gateway-contract/behaviour/assertions';
import { sameBytes, utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { backendCase, type BackendCase, type BackendContext } from './backend-case.ts';
import { fixtureCommit, type FixtureCommit } from './backend-fixtures.ts';
import { expectAccepted, newObjects, pushRef, seedRepo } from './push-helpers.ts';

const GROUP = 'reads';
const MISSING = '0123456789abcdef0123456789abcdef01234567';

const FILES = {
  'README.md': '# Read cases\n',
  'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' as const },
  link: { content: 'README.md', mode: '120000' as const },
  'content/pages/about.md': 'About\n',
};

/** Seeds a repository with a small history: root → second (on main), plus a merge on top. */
async function seedHistory(
  context: BackendContext,
): Promise<{ root: FixtureCommit; second: FixtureCommit; side: FixtureCommit; merge: FixtureCommit }> {
  const root = await seedRepo(context, FILES);
  const second = await fixtureCommit(
    { ...FILES, 'content/pages/about.md': 'About, revised\n' },
    [root.sha],
    'Revise about\n',
  );
  expectAccepted(
    await pushRef(context, 'refs/heads/main', root.sha, second.sha, newObjects(second, root)),
    'refs/heads/main',
  );
  const side = await fixtureCommit({ ...FILES, 'side.txt': 'side\n' }, [root.sha], 'Side change\n');
  const merge = await fixtureCommit(
    { ...FILES, 'content/pages/about.md': 'About, revised\n', 'side.txt': 'side\n' },
    [second.sha, side.sha],
    'Merge side\n\nGateway-Idempotency-Key: contract:merge\n',
  );
  const objects = [...side.objects, ...merge.objects];
  expectAccepted(
    await pushRef(context, 'refs/heads/main', second.sha, merge.sha, objects),
    'refs/heads/main',
  );
  return { root, second, side, merge };
}

const textOf = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes);

/** resolveRef, readCommit, readTree, readBlob, readFile and log. */
export const readCases: readonly BackendCase[] = [
  backendCase(GROUP, 'readCommit returns a pushed commit exactly, trailer parsed', async (context) => {
    const { root, merge } = await seedHistory(context);
    assertEqual(await context.backend.readCommit(context.repo, root.sha), root.commit, 'root commit');
    const read = present(await context.backend.readCommit(context.repo, merge.sha), 'merge commit');
    assertEqual(read, merge.commit, 'merge commit with two parents');
    assertEqual(read.idempotencyKey, 'contract:merge', 'idempotency trailer parsed');
  }),
  backendCase(GROUP, 'readCommit of an unknown id is null', async (context) => {
    await seedRepo(context);
    assertEqual(await context.backend.readCommit(context.repo, MISSING), null, 'null');
  }),
  backendCase(GROUP, 'reading an id as the wrong kind of object is null', async (context) => {
    const root = await seedRepo(context, FILES);
    const blob = present(
      root.objects.find((object) => object.type === 'blob'),
      'a blob',
    );
    const { backend, repo } = context;
    assertEqual(await backend.readCommit(repo, blob.sha), null, 'readCommit of a blob');
    assertEqual(await backend.readCommit(repo, root.commit.tree), null, 'readCommit of a tree');
    assertEqual(await backend.readTree(repo, blob.sha), null, 'readTree of a blob');
    assertEqual(await backend.readTree(repo, root.sha), null, 'readTree of a commit');
    assertEqual(await backend.readBlob(repo, root.commit.tree), null, 'readBlob of a tree');
    assertEqual(await backend.readBlob(repo, root.sha), null, 'readBlob of a commit');
  }),
  backendCase(GROUP, 'readTree lists one level in stored order with kinds and modes', async (context) => {
    const { root } = await seedHistory(context);
    const entries = present(await context.backend.readTree(context.repo, root.commit.tree), 'root tree');
    assertEqual(
      entries.map((entry) => [entry.name, entry.type, entry.mode]),
      [
        ['README.md', 'blob', '100644'],
        ['bin', 'tree', '040000'],
        ['content', 'tree', '040000'],
        ['link', 'blob', '120000'],
      ],
      'root entries',
    );
    const bin = present(
      entries.find((entry) => entry.name === 'bin'),
      'bin entry',
    );
    const binEntries = present(await context.backend.readTree(context.repo, bin.sha), 'bin tree');
    assertEqual(
      binEntries.map((entry) => [entry.name, entry.type, entry.mode]),
      [['run.sh', 'blob', '100755']],
      'subtree',
    );
    assertTrue(
      entries.every((entry) => root.objects.some((object) => object.sha === entry.sha)),
      'entry ids match',
    );
  }),
  backendCase(GROUP, 'readTree of an unknown id is null', async (context) => {
    await seedRepo(context);
    assertEqual(await context.backend.readTree(context.repo, MISSING), null, 'null');
  }),
  backendCase(GROUP, 'readBlob returns bytes by id, null for an unknown id', async (context) => {
    const root = await seedRepo(context, FILES);
    const blob = present(
      root.objects.find((object) => object.type === 'blob' && textOf(object.data) === 'About\n'),
      'about blob',
    );
    assertTrue(
      sameBytes(present(await context.backend.readBlob(context.repo, blob.sha), 'blob'), blob.data),
      'bytes',
    );
    assertEqual(await context.backend.readBlob(context.repo, MISSING), null, 'unknown id');
  }),
  backendCase(GROUP, 'readFile reads by branch and by commit id, nested paths included', async (context) => {
    const { root } = await seedHistory(context);
    const { backend, repo } = context;
    assertEqual(
      textOf(await backend.readFile(repo, 'main', 'content/pages/about.md')),
      'About, revised\n',
      'at main',
    );
    assertEqual(
      textOf(await backend.readFile(repo, root.sha, 'content/pages/about.md')),
      'About\n',
      'at the root commit',
    );
    assertEqual(
      textOf(await backend.readFile(repo, 'main', 'bin/run.sh')),
      '#!/bin/sh\necho hi\n',
      'executable file',
    );
    assertEqual(textOf(await backend.readFile(repo, 'main', 'link')), 'README.md', 'symlink target');
  }),
  backendCase(
    GROUP,
    'readFile is null for a missing path, a directory, a missing branch or commit',
    async (context) => {
      await seedHistory(context);
      const { backend, repo } = context;
      assertEqual(await backend.readFile(repo, 'main', 'nope.md'), null, 'missing path');
      assertEqual(await backend.readFile(repo, 'main', 'content/pages/nope.md'), null, 'missing nested path');
      assertEqual(await backend.readFile(repo, 'main', 'README.md/x'), null, 'beneath a file');
      assertEqual(await backend.readFile(repo, 'main', 'content'), null, 'a directory');
      assertEqual(await backend.readFile(repo, 'no-such-branch', 'README.md'), null, 'missing branch');
      assertEqual(await backend.readFile(repo, MISSING, 'README.md'), null, 'missing commit');
    },
  ),
  backendCase(
    GROUP,
    'log lists the first-parent chain newest first, with limit and offset',
    async (context) => {
      const { root, second, merge } = await seedHistory(context);
      const { backend, repo } = context;
      const shas = async (ref: string, limit: number, offset?: number): Promise<string[]> =>
        (await backend.log(repo, ref, offset === undefined ? { limit } : { limit, offset })).map(
          (commit) => commit.sha,
        );
      assertEqual(await shas('main', 10), [merge.sha, second.sha, root.sha], 'first parents only');
      assertEqual(await shas('main', 2), [merge.sha, second.sha], 'limit');
      assertEqual(await shas('main', 10, 1), [second.sha, root.sha], 'offset');
      assertEqual(await shas('main', 10, 3), [], 'offset past the end');
      assertEqual(await shas(second.sha, 10), [second.sha, root.sha], 'from a commit id');
      assertEqual((await backend.log(repo, 'main', { limit: 1 }))[0], merge.commit, 'commits are complete');
      assertEqual(await backend.log(repo, 'no-such-branch', { limit: 5 }), [], 'missing branch');
    },
  ),
  backendCase(
    GROUP,
    'resolveRef resolves short names, full refs and tags; null when missing',
    async (context) => {
      const seeded = await seedRepo(context);
      expectAccepted(await pushRef(context, 'refs/tags/v1.0.0', ZERO_SHA, seeded.sha), 'refs/tags/v1.0.0');
      const { backend, repo } = context;
      assertEqual(await backend.resolveRef(repo, 'main'), seeded.sha, 'short name');
      assertEqual(await backend.resolveRef(repo, 'refs/heads/main'), seeded.sha, 'full ref');
      assertEqual(await backend.resolveRef(repo, 'refs/tags/v1.0.0'), seeded.sha, 'lightweight tag');
      assertEqual(await backend.resolveRef(repo, 'staging'), null, 'missing branch');
      assertEqual(await backend.resolveRef(repo, 'refs/tags/v9'), null, 'missing tag');
    },
  ),
  backendCase(GROUP, 'unicode paths and every byte value round-trip', async (context) => {
    const bytes = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
    await seedRepo(context, {
      'pages/café/naïve 日本.md': 'unicode\n',
      'data/all-bytes.bin': { content: bytes },
    });
    const { backend, repo } = context;
    assertEqual(
      textOf(await backend.readFile(repo, 'main', 'pages/café/naïve 日本.md')),
      'unicode\n',
      'unicode path',
    );
    assertTrue(
      sameBytes(present(await backend.readFile(repo, 'main', 'data/all-bytes.bin'), 'binary'), bytes),
      'all bytes',
    );
    assertTrue(
      sameBytes(
        utf8('unicode\n'),
        present(await backend.readFile(repo, 'main', 'pages/café/naïve 日本.md'), 'f'),
      ),
      'bytes',
    );
  }),
];
