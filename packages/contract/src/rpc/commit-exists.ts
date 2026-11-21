// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { BranchName, RepoName } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `commitExists`. */
export const CommitExistsInput = z
  .object({
    repo: RepoName.describe('Repository to look in.'),
    sha: Sha.describe('Commit id to look for.'),
    branch: BranchName.optional().describe(
      "When given, the commit must also be reachable from this branch's head (the head itself or an ancestor). Absent: any commit in the repository counts.",
    ),
  })
  .strict()
  .meta({
    id: 'CommitExistsInput',
    title: 'commitExists input',
    description: 'Input of commitExists(): is this commit in the repository, optionally on a branch?',
    examples: [{ repo: 'acme-raw-content', sha: EXAMPLE_SHA_B, branch: 'main' }],
  });

/** Input of `commitExists`, inferred from {@link CommitExistsInput}. */
export type CommitExistsInput = z.input<typeof CommitExistsInput>;

/** Output of `commitExists`. */
export const CommitExistsOutput = z
  .object({
    exists: z
      .boolean()
      .describe(
        'true when the commit exists (and is reachable from `branch` when one was named); false otherwise, including when the branch does not exist.',
      ),
  })
  .strict()
  .meta({
    id: 'CommitExistsOutput',
    title: 'commitExists output',
    description: 'Output of commitExists().',
    examples: [{ exists: true }],
  });

/** Output of `commitExists`, inferred from {@link CommitExistsOutput}. */
export type CommitExistsOutput = z.infer<typeof CommitExistsOutput>;
