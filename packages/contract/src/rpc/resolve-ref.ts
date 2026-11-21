// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { RepoName, Revision } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `resolveRef`. */
export const ResolveRefInput = z
  .object({
    repo: RepoName.describe('Repository to look in.'),
    ref: Revision.describe('Branch name to resolve, or commit id to check.'),
  })
  .strict()
  .meta({
    id: 'ResolveRefInput',
    title: 'resolveRef input',
    description: 'Input of resolveRef(): resolve a branch to its head, or confirm a commit id exists.',
    examples: [{ repo: 'acme-raw-content', ref: 'main' }],
  });

/** Input of `resolveRef`, inferred from {@link ResolveRefInput}. */
export type ResolveRefInput = z.input<typeof ResolveRefInput>;

/** Output of `resolveRef`. */
export const ResolveRefOutput = z
  .object({
    sha: Sha.describe('Id of the commit the ref names.'),
  })
  .strict()
  .nullable()
  .meta({
    id: 'ResolveRefOutput',
    title: 'resolveRef output',
    description:
      'Output of resolveRef(): the commit id the ref names, or null when the branch or commit does not exist.',
    examples: [{ sha: EXAMPLE_SHA_B }, null],
  });

/** Output of `resolveRef`, inferred from {@link ResolveRefOutput}. */
export type ResolveRefOutput = z.infer<typeof ResolveRefOutput>;
