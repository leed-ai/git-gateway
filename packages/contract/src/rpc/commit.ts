// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Commit } from '../schemas/commit.ts';
import { CommitAction } from '../schemas/commit-action.ts';
import {
  EXAMPLE_COMMIT as COMMIT_EXAMPLE,
  EXAMPLE_IDENTITY as ADA,
  EXAMPLE_SHA_A as SHA_A,
  EXAMPLE_SHA_B as SHA_B,
} from '../schemas/examples.ts';
import { Identity } from '../schemas/identity.ts';
import { BranchName, IdempotencyKey, RepoName } from '../schemas/names.ts';
import { RefUpdate } from '../schemas/ref-update.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `commit`. */
export const CommitInput = z
  .object({
    repo: RepoName.describe('Repository to commit to.'),
    branch: BranchName.describe(
      'Branch to commit to. If it does not exist it is created: from `startBranch` when given, or as a root commit when the repository has no branches at all; otherwise the call fails with ref_not_found.',
    ),
    startBranch: BranchName.optional().describe(
      'Branch to start `branch` from when `branch` does not exist yet; ignored when it does. Absent: no start branch.',
    ),
    expectedHead: Sha.nullable()
      .optional()
      .describe(
        'Head the caller based its change on. When given and the branch head differs, the call fails with stale_head; null expects the branch not to exist yet. Absent: commit onto whatever the head is.',
      ),
    message: z
      .string()
      .min(1)
      .max(65_536)
      .refine((text) => text.trim().length > 0, { message: 'message must not be blank' })
      .describe(
        'Commit message, 1–65536 characters and not blank. The gateway appends the idempotency trailer.',
      ),
    author: Identity.describe('Who wrote the change.'),
    committer: Identity.optional().describe('Who records the commit. Absent: the author.'),
    actions: z
      .array(CommitAction)
      .min(1)
      .max(1000)
      .describe('Changes to apply, in order, each to the result of the previous; 1–1000 actions.'),
    idempotencyKey: IdempotencyKey.describe(
      'Makes the call safe to retry: if a commit with this key is in the branch\'s recent history, it is returned (status "replayed") and nothing is written.',
    ),
  })
  .strict()
  .meta({
    id: 'CommitInput',
    title: 'commit input',
    description:
      'Input of commit(): a multi-file commit to one branch, built without a clone. Checked in this order: idempotency replay, then stale head, then the actions.',
    examples: [
      {
        repo: 'acme-raw-content',
        branch: 'staging',
        expectedHead: SHA_A,
        message: 'Update about page',
        author: ADA,
        actions: [{ action: 'update', path: 'content/about.md', content: '# About us\n', encoding: 'text' }],
        idempotencyKey: 'cms:publish:2f9c1e',
      },
    ],
  });

/** Input of `commit` as accepted (defaults optional). */
export type CommitInput = z.input<typeof CommitInput>;

/** A new commit was written. */
export const CommitCommitted = z
  .object({
    status: z.literal('committed').describe('A new commit was written and the branch moved to it.'),
    commit: Commit.describe('The commit written.'),
    refUpdate: RefUpdate.describe('How the branch moved; oldSha is all zeros when the commit created it.'),
  })
  .strict()
  .meta({
    id: 'CommitCommitted',
    title: 'commit: committed',
    description: 'commit() wrote a new commit and moved the branch to it.',
    examples: [
      {
        status: 'committed',
        commit: COMMIT_EXAMPLE,
        refUpdate: { ref: 'refs/heads/staging', oldSha: SHA_A, newSha: SHA_B },
      },
    ],
  });

/** The key was found in recent history; that commit is returned. */
export const CommitReplayed = z
  .object({
    status: z
      .literal('replayed')
      .describe('A commit with the same idempotency key already exists; nothing was written.'),
    commit: Commit.describe('The earlier commit carrying the same idempotency key.'),
  })
  .strict()
  .meta({
    id: 'CommitReplayed',
    title: 'commit: replayed',
    description:
      "commit() found a commit with the same idempotency key in the branch's recent history and returned it without writing.",
    examples: [{ status: 'replayed', commit: COMMIT_EXAMPLE }],
  });

/** The actions changed nothing. */
export const CommitNoop = z
  .object({
    status: z.literal('noop').describe('The actions left the tree unchanged; nothing was written or pushed.'),
    head: Sha.nullable().describe('The branch head, unchanged; null when the branch does not exist.'),
  })
  .strict()
  .meta({
    id: 'CommitNoop',
    title: 'commit: no-op',
    description:
      "commit() applied the actions and the resulting tree equals the head's, so nothing was written.",
    examples: [{ status: 'noop', head: SHA_A }],
  });

/** Inline retries ran out; a Workflow finishes the commit. */
export const CommitQueued = z
  .object({
    status: z.literal('queued').describe('Inline retries ran out; a CommitWorkflow finishes the commit.'),
    workflowInstanceId: z
      .string()
      .min(1)
      .max(100)
      .describe('Id of the CommitWorkflow instance carrying the same idempotency key.'),
  })
  .strict()
  .meta({
    id: 'CommitQueued',
    title: 'commit: queued',
    description:
      'commit() hit stale-head refusals more times than the inline retry budget and handed the commit to a CommitWorkflow with the same idempotency key. The in-memory reference never returns this.',
    examples: [{ status: 'queued', workflowInstanceId: 'commit-cms-publish-2f9c1e' }],
  });

/** Output of `commit`, discriminated by `status`. */
export const CommitOutput = z
  .discriminatedUnion('status', [CommitCommitted, CommitReplayed, CommitNoop, CommitQueued])
  .meta({
    id: 'CommitOutput',
    title: 'commit output',
    description: 'Output of commit(), discriminated by `status`.',
    examples: [{ status: 'noop', head: SHA_A }],
  });

/** Output of `commit`, inferred from {@link CommitOutput}. */
export type CommitOutput = z.infer<typeof CommitOutput>;
