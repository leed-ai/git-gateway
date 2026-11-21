// SPDX-License-Identifier: Apache-2.0
import { EXAMPLE_SHA_A, EXAMPLE_SHA_B } from '@leed-ai/git-gateway-contract/schemas/examples';
import { BranchName, FilePath, RepoName } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

/** What a SyncBranchWorkflow instance is started with. */
export const SyncBranchWorkflowParams = z
  .object({
    repo: RepoName.describe('Repository holding both branches.'),
    from: BranchName.describe('Branch whose commits are brought into `into`, e.g. main.'),
    into: BranchName.describe('Branch brought up to date, e.g. staging; only fast-forwarded or merged into.'),
    fromHead: Sha.describe(
      'Head of `from` the push left; identifies the instance, so one push starts at most one sync.',
    ),
  })
  .strict()
  .refine((params) => params.from !== params.into, { message: 'from and into must differ', path: ['into'] })
  .meta({
    id: 'SyncBranchWorkflowParams',
    title: 'SyncBranchWorkflow params',
    description:
      'The params a SyncBranchWorkflow instance is started with by an onPush sync rule: sync `into` with `from` after a push moved `from` to `fromHead`. The sync merges whatever `from` holds when it runs.',
    examples: [{ repo: 'acme-raw-content', from: 'main', into: 'staging', fromHead: EXAMPLE_SHA_B }],
  });

/** SyncBranchWorkflow params, inferred from {@link SyncBranchWorkflowParams}. */
export type SyncBranchWorkflowParams = z.infer<typeof SyncBranchWorkflowParams>;

/** `into` already contained `from`. */
export const SyncStepUpToDate = z
  .object({
    status: z
      .literal('up_to_date')
      .describe('`into` already contained `from` (possibly because an earlier run of the step merged it).'),
    head: Sha.describe('Head of `into`, unchanged.'),
  })
  .strict()
  .meta({
    id: 'SyncStepUpToDate',
    title: 'sync step: up to date',
    description: "The SyncBranchWorkflow's sync step found nothing to do.",
    examples: [{ status: 'up_to_date', head: EXAMPLE_SHA_A }],
  });

/** `into` was fast-forwarded. */
export const SyncStepFastForward = z
  .object({
    status: z.literal('fast_forward').describe('`into` had no commits of its own and was fast-forwarded.'),
    head: Sha.describe('New head of `into`, the head of `from`.'),
  })
  .strict()
  .meta({
    id: 'SyncStepFastForward',
    title: 'sync step: fast-forward',
    description: "The SyncBranchWorkflow's sync step fast-forwarded `into`.",
    examples: [{ status: 'fast_forward', head: EXAMPLE_SHA_B }],
  });

/** A merge commit was written. */
export const SyncStepMerged = z
  .object({
    status: z.literal('merged').describe('Both branches had commits; a file-level merge commit was written.'),
    head: Sha.describe('New head of `into`, the merge commit.'),
  })
  .strict()
  .meta({
    id: 'SyncStepMerged',
    title: 'sync step: merged',
    description: "The SyncBranchWorkflow's sync step wrote a merge commit to `into`.",
    examples: [{ status: 'merged', head: EXAMPLE_SHA_B }],
  });

/** The branches conflict. */
export const SyncStepConflict = z
  .object({
    status: z
      .literal('conflict')
      .describe(
        'Some paths changed differently on both sides; nothing was written and retrying cannot help.',
      ),
    paths: z
      .array(FilePath.describe('A conflicting path.'))
      .min(1)
      .describe('Every conflicting path, sorted in byte order (paths only, never content).'),
    base: Sha.describe('The merge base used.'),
    fromHead: Sha.describe('The head of `from` merged.'),
    intoHead: Sha.describe('The head of `into`, unchanged.'),
  })
  .strict()
  .meta({
    id: 'SyncStepConflict',
    title: 'sync step: conflict',
    description:
      "The SyncBranchWorkflow's sync step could not merge; the instance completes with this result so the conflict can be reported and resolved by hand.",
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

/**
 * What the SyncBranchWorkflow's sync step stores and the instance returns: ids and paths only,
 * never file content or a credential.
 */
export const SyncStepResult = z
  .discriminatedUnion('status', [SyncStepUpToDate, SyncStepFastForward, SyncStepMerged, SyncStepConflict])
  .meta({
    id: 'SyncStepResult',
    title: 'SyncBranchWorkflow result',
    description:
      "What the SyncBranchWorkflow's sync step stores and the instance returns, discriminated by `status`: commit ids and conflicting paths only.",
    examples: [{ status: 'merged', head: EXAMPLE_SHA_B }],
  });

/** A SyncBranchWorkflow result, inferred from {@link SyncStepResult}. */
export type SyncStepResult = z.infer<typeof SyncStepResult>;
