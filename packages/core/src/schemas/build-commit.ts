// SPDX-License-Identifier: Apache-2.0
import { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { CommitAction } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import {
  EXAMPLE_COMMIT,
  EXAMPLE_IDENTITY,
  EXAMPLE_TIMESTAMP,
} from '@leed-ai/git-gateway-contract/schemas/examples';
import { Identity } from '@leed-ai/git-gateway-contract/schemas/identity';
import { BranchName, IdempotencyKey } from '@leed-ai/git-gateway-contract/schemas/names';
import { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { CommitTimestamp, GitObject } from './git-object.ts';

const HEAD = {
  sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
};

/** The commit a new commit builds on. */
export const BaseCommit = z
  .object({
    sha: Sha.describe("Id of the commit, which becomes the new commit's parent."),
    tree: Sha.describe('Id of its root tree, which the actions apply to.'),
  })
  .strict()
  .meta({
    id: 'BaseCommit',
    title: 'Base commit',
    description:
      'The commit a new commit builds on: its id (the parent) and its root tree (what the actions edit).',
    examples: [HEAD],
  });

/** Input of buildCommit. */
export const BuildCommitInput = z
  .object({
    branch: BranchName.describe('Branch the commit is for; named in the returned ref update.'),
    base: BaseCommit.nullable().describe(
      'The commit to build on, normally the branch head; null for a root commit on an empty repository.',
    ),
    oldSha: Sha.nullable()
      .optional()
      .describe(
        "What the branch names now, for the ref update; null when the branch does not exist yet (a new branch started from another's head). Absent: the base commit, or null without one.",
      ),
    actions: z.array(CommitAction).min(1).max(1000).describe('Commit actions to apply in order; 1–1000.'),
    message: z
      .string()
      .min(1)
      .max(65_536)
      .refine((text) => text.trim().length > 0, { message: 'message must not be blank' })
      .describe(
        "The caller's commit message, 1–65536 characters, not blank; the idempotency trailer is appended.",
      ),
    author: Identity.describe('Who wrote the change.'),
    committer: Identity.optional().describe('Who records the commit. Absent: the author.'),
    idempotencyKey: IdempotencyKey.describe(
      'Recorded as the "Gateway-Idempotency-Key:" trailer of the message.',
    ),
    date: CommitTimestamp.describe(
      'Author and committer date, 1970 or later; stored in whole seconds at +0000.',
    ),
  })
  .strict()
  .meta({
    id: 'BuildCommitInput',
    title: 'buildCommit input',
    description:
      'Everything needed to build a commit without a clone: the base commit, the actions, the message and identities, the idempotency key and the date.',
    examples: [
      {
        branch: 'staging',
        base: HEAD,
        actions: [{ action: 'create', path: 'content/about.md', content: '# About\n', encoding: 'text' }],
        message: 'Update about page',
        author: EXAMPLE_IDENTITY,
        idempotencyKey: 'cms:publish:2f9c1e',
        date: EXAMPLE_TIMESTAMP,
      },
    ],
  });

/** Input of buildCommit, as accepted (defaults optional). */
export type BuildCommitInput = z.input<typeof BuildCommitInput>;

/** A commit was built and is ready to push. */
export const CommitReady = z
  .object({
    status: z.literal('ready').describe('A new commit was built; push `objects` with `refUpdate`.'),
    commit: Commit.describe('The new commit.'),
    refUpdate: RefUpdate.describe('The receive-pack command that moves the branch to the new commit.'),
    objects: z
      .array(GitObject)
      .min(1)
      .describe('Every object to push: new blobs, new trees and the commit itself (last).'),
  })
  .strict()
  .meta({
    id: 'CommitReady',
    title: 'Commit ready',
    description:
      'A commit built from actions, with the objects to pack and the ref update to send. Nothing has been written to storage yet.',
    examples: [
      {
        status: 'ready',
        commit: EXAMPLE_COMMIT,
        refUpdate: {
          ref: 'refs/heads/staging',
          oldSha: EXAMPLE_COMMIT.parents[0],
          newSha: EXAMPLE_COMMIT.sha,
        },
        objects: [{ type: 'blob', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', data: new Uint8Array(0) }],
      },
    ],
  });

/** The actions changed nothing. */
export const CommitUnchanged = z
  .object({
    status: z.literal('noop').describe('The actions left the tree unchanged; there is nothing to push.'),
    head: Sha.nullable().describe('The base commit id, unchanged; null when there was none.'),
  })
  .strict()
  .meta({
    id: 'CommitUnchanged',
    title: 'Commit unchanged',
    description: 'The actions were valid but produced the base tree again, so no commit was built.',
    examples: [{ status: 'noop', head: HEAD.sha }],
  });

/** The outcome of buildCommit. */
export const BuiltCommit = z.discriminatedUnion('status', [CommitReady, CommitUnchanged]).meta({
  id: 'BuiltCommit',
  title: 'Built commit',
  description: 'The outcome of buildCommit, discriminated by `status`.',
  examples: [{ status: 'noop', head: HEAD.sha }],
});

/** The outcome of buildCommit, inferred from {@link BuiltCommit}. */
export type BuiltCommit = z.infer<typeof BuiltCommit>;
