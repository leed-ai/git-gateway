// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_SHA_A, EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { BranchName, RepoName } from '../schemas/names.ts';
import { RefUpdate } from '../schemas/ref-update.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `promote`. */
export const PromoteInput = z
  .object({
    repo: RepoName.describe('Repository holding both branches.'),
    from: BranchName.describe('Branch whose head is promoted, e.g. staging.'),
    into: BranchName.describe('Branch fast-forwarded, e.g. main. Created at `sha` if it does not exist.'),
    sha: Sha.describe('The commit to promote; must be the current head of `from`.'),
  })
  .strict()
  .refine((input) => input.from !== input.into, { message: 'from and into must differ', path: ['into'] })
  .meta({
    id: 'PromoteInput',
    title: 'promote input',
    description:
      'Input of promote(): fast-forward `into` to `sha`, only if `sha` is the head of `from` and contains the head of `into`. Never merges, never forces. Refusals: ref_not_found (from missing), not_head_of_source, not_fast_forward.',
    examples: [{ repo: 'acme-raw-content', from: 'staging', into: 'main', sha: EXAMPLE_SHA_B }],
  });

/** Input of `promote`, inferred from {@link PromoteInput}. */
export type PromoteInput = z.input<typeof PromoteInput>;

/** `into` was fast-forwarded (or created) at `sha`. */
export const PromotePromoted = z
  .object({
    status: z.literal('promoted').describe('`into` now points at `sha`.'),
    refUpdate: RefUpdate.describe('How `into` moved; oldSha is all zeros when promote created it.'),
  })
  .strict()
  .meta({
    id: 'PromotePromoted',
    title: 'promote: promoted',
    description: 'promote() fast-forwarded `into` to `sha`, or created it there.',
    examples: [
      {
        status: 'promoted',
        refUpdate: { ref: 'refs/heads/main', oldSha: EXAMPLE_SHA_A, newSha: EXAMPLE_SHA_B },
      },
    ],
  });

/** `into` already pointed at `sha`. */
export const PromoteUpToDate = z
  .object({
    status: z.literal('up_to_date').describe('`into` already points at `sha`; nothing changed.'),
    head: Sha.describe('The head of `into`, equal to `sha`.'),
  })
  .strict()
  .meta({
    id: 'PromoteUpToDate',
    title: 'promote: up to date',
    description: 'promote() found `into` already at `sha`.',
    examples: [{ status: 'up_to_date', head: EXAMPLE_SHA_B }],
  });

/** Output of `promote`, discriminated by `status`. */
export const PromoteOutput = z.discriminatedUnion('status', [PromotePromoted, PromoteUpToDate]).meta({
  id: 'PromoteOutput',
  title: 'promote output',
  description: 'Output of promote(), discriminated by `status`. Refusals are thrown as GatewayErrors.',
  examples: [{ status: 'up_to_date', head: EXAMPLE_SHA_B }],
});

/** Output of `promote`, inferred from {@link PromoteOutput}. */
export type PromoteOutput = z.infer<typeof PromoteOutput>;
