// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Commit } from '../schemas/commit.ts';
import { EXAMPLE_COMMIT, EXAMPLE_SHA_A, EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { Identity } from '../schemas/identity.ts';
import { BranchName, FilePath, RepoName } from '../schemas/names.ts';
import { RefUpdate } from '../schemas/ref-update.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `syncBranch`. */
export const SyncBranchInput = z
  .object({
    repo: RepoName.describe('Repository holding both branches.'),
    from: BranchName.describe('Branch whose commits are brought into `into`.'),
    into: BranchName.describe(
      'Branch brought up to date; never rewritten, only fast-forwarded or merged into.',
    ),
    author: Identity.optional().describe(
      'Author and committer of a merge commit, if one is needed. Absent: the configured service identity.',
    ),
    message: z
      .string()
      .min(1)
      .max(65_536)
      .optional()
      .describe(
        'Message of a merge commit, if one is needed. Absent: "Merge branch \'<from>\' into <into>".',
      ),
  })
  .strict()
  .refine((input) => input.from !== input.into, { message: 'from and into must differ', path: ['into'] })
  .meta({
    id: 'SyncBranchInput',
    title: 'syncBranch input',
    description:
      'Input of syncBranch(): bring `into` up to date with `from` without rewriting `into`. Fails with ref_not_found if either branch is missing and unrelated_histories if they share no ancestor.',
    examples: [{ repo: 'acme-raw-content', from: 'main', into: 'staging' }],
  });

/** Input of `syncBranch`, inferred from {@link SyncBranchInput}. */
export type SyncBranchInput = z.input<typeof SyncBranchInput>;

/** `into` already contains `from`. */
export const SyncUpToDate = z
  .object({
    status: z.literal('up_to_date').describe('`into` already contains the head of `from`; nothing changed.'),
    head: Sha.describe('The head of `into`, unchanged.'),
  })
  .strict()
  .meta({
    id: 'SyncUpToDate',
    title: 'syncBranch: up to date',
    description: 'syncBranch() found that `into` already contains the head of `from`.',
    examples: [{ status: 'up_to_date', head: EXAMPLE_SHA_A }],
  });

/** `into` had no commits of its own and was fast-forwarded. */
export const SyncFastForward = z
  .object({
    status: z
      .literal('fast_forward')
      .describe('`into` had no commits of its own and now points at the head of `from`.'),
    refUpdate: RefUpdate.describe('How `into` moved.'),
  })
  .strict()
  .meta({
    id: 'SyncFastForward',
    title: 'syncBranch: fast-forward',
    description:
      'syncBranch() fast-forwarded `into` to the head of `from` with a ref update naming the old head.',
    examples: [
      {
        status: 'fast_forward',
        refUpdate: { ref: 'refs/heads/staging', oldSha: EXAMPLE_SHA_A, newSha: EXAMPLE_SHA_B },
      },
    ],
  });

/** Both sides had commits; a merge commit was written. */
export const SyncMerged = z
  .object({
    status: z
      .literal('merged')
      .describe('Both branches had commits; a file-level merge commit was written to `into`.'),
    commit: Commit.describe(
      'The merge commit; its parents are the old head of `into`, then the head of `from`.',
    ),
    refUpdate: RefUpdate.describe('How `into` moved.'),
  })
  .strict()
  .meta({
    id: 'SyncMerged',
    title: 'syncBranch: merged',
    description:
      'syncBranch() merged file by file against the merge base: a path changed on one side takes that side.',
    examples: [
      {
        status: 'merged',
        commit: EXAMPLE_COMMIT,
        refUpdate: { ref: 'refs/heads/staging', oldSha: EXAMPLE_SHA_A, newSha: EXAMPLE_SHA_B },
      },
    ],
  });

/** Both sides changed the same paths differently; nothing was written. */
export const SyncConflict = z
  .object({
    status: z
      .literal('conflict')
      .describe('Some paths changed differently on both sides; nothing was written.'),
    paths: z
      .array(FilePath.describe('A conflicting path.'))
      .min(1)
      .describe(
        'Every conflicting path, sorted in byte order: changed differently on both sides, or a file on one side where the other has a directory.',
      ),
    base: Sha.describe('The merge base used.'),
    fromHead: Sha.describe('The head of `from` merged.'),
    intoHead: Sha.describe('The head of `into`, unchanged.'),
  })
  .strict()
  .meta({
    id: 'SyncConflict',
    title: 'syncBranch: conflict',
    description: 'syncBranch() could not merge: the listed paths conflict. `into` is unchanged.',
    examples: [
      {
        status: 'conflict',
        paths: ['content/about.md'],
        base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        fromHead: EXAMPLE_SHA_B,
        intoHead: EXAMPLE_SHA_A,
      },
    ],
  });

/** Output of `syncBranch`, discriminated by `status`. */
export const SyncBranchOutput = z
  .discriminatedUnion('status', [SyncUpToDate, SyncFastForward, SyncMerged, SyncConflict])
  .meta({
    id: 'SyncBranchOutput',
    title: 'syncBranch output',
    description: 'Output of syncBranch(), discriminated by `status`.',
    examples: [{ status: 'up_to_date', head: EXAMPLE_SHA_A }],
  });

/** Output of `syncBranch`, inferred from {@link SyncBranchOutput}. */
export type SyncBranchOutput = z.infer<typeof SyncBranchOutput>;
