// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { createCommit } from '../../src/objects/commit-object.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { encodeTree } from '../../src/objects/tree-object.ts';
import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import { arbitrarySha } from '../helpers/arbitraries.ts';
import { GIT, GitSandbox } from '../helpers/git.ts';

const sandbox = new GitSandbox();
const repo = sandbox.bare('objects.git');
afterAll(() => sandbox.dispose());

const TYPE_OF_MODE: Readonly<Record<string, string>> = {
  '100644': 'blob',
  '100755': 'blob',
  '120000': 'blob',
  '040000': 'tree',
  '160000': 'commit',
};

const entryName = fc
  .stringMatching(/^[a-zA-Z0-9._\- éü]{1,16}$/)
  .filter((name) => !['.', '..', '.git'].includes(name.toLowerCase()));

const entry: fc.Arbitrary<GitTreeEntry> = fc.record({
  name: entryName,
  mode: fc.constantFrom('100644', '100755', '120000', '040000', '160000'),
  sha: arbitrarySha,
});

describe(`objects against ${GIT}`, () => {
  it('hash blobs identically to git hash-object', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (content) => {
        expect(await hashObject('blob', content)).toBe(
          sandbox.text(['hash-object', '--stdin'], { input: content }),
        );
      }),
      { numRuns: 40 },
    );
  });

  it('hash trees identically to git mktree', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(entry, { selector: (e) => e.name, minLength: 1, maxLength: 12 }),
        async (entries) => {
          const listing = entries
            .map((e) => `${e.mode} ${TYPE_OF_MODE[e.mode] ?? ''} ${e.sha}\t${e.name}\n`)
            .join('');
          const expected = sandbox.text(['--git-dir', repo, 'mktree', '--missing'], {
            input: new TextEncoder().encode(listing),
          });
          expect(await hashObject('tree', encodeTree(entries))).toBe(expected);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('hash commits identically to git commit-tree', async () => {
    const tree = sandbox.text(['--git-dir', repo, 'mktree'], { input: new Uint8Array(0) });
    const identity = fc.record({
      name: fc.stringMatching(/^[A-Za-z][A-Za-z .'-]{0,20}[A-Za-z]$/),
      email: fc.stringMatching(/^[a-z]{1,8}@[a-z]{1,8}\.(?:com|org)$/),
    });
    await fc.assert(
      fc.asyncProperty(
        identity,
        identity,
        // git refuses implausibly small timestamps such as 0, so start in 1973.
        fc.integer({ min: 100_000_000, max: 4_000_000_000 }),
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:;!?'()\n-]{0,80}$/),
        async (author, committer, seconds, subject) => {
          const message = `${subject.trim() || 'x'}\n`;
          const date = new Date(seconds * 1000).toISOString();
          const { commit } = await createCommit({
            tree,
            parents: [],
            author: { ...author, date },
            committer: { ...committer, date },
            message,
          });
          const expected = sandbox.text(
            ['--git-dir', repo, 'commit-tree', '--no-gpg-sign', tree, '-F', '-'],
            {
              input: new TextEncoder().encode(message),
              env: {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_AUTHOR_DATE: `${seconds} +0000`,
                GIT_COMMITTER_NAME: committer.name,
                GIT_COMMITTER_EMAIL: committer.email,
                GIT_COMMITTER_DATE: `${seconds} +0000`,
              },
            },
          );
          expect(commit.sha).toBe(expected);
        },
      ),
      { numRuns: 25 },
    );
  });
});
