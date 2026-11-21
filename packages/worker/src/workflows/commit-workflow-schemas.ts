// SPDX-License-Identifier: Apache-2.0
import { CommitInput } from '@leed-ai/git-gateway-contract/rpc/commit';
import {
  EXAMPLE_IDENTITY,
  EXAMPLE_SHA_A,
  EXAMPLE_SHA_B,
} from '@leed-ai/git-gateway-contract/schemas/examples';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

/** What a CommitWorkflow instance is started with: the commit() input, unchanged. */
export const CommitWorkflowParams = CommitInput.meta({
  id: 'CommitWorkflowParams',
  title: 'CommitWorkflow params',
  description:
    'The params a CommitWorkflow instance is started with: exactly the commit() input whose inline retries ran out, idempotency key included, so the workflow writes the same commit at most once. Params may carry file content; step results never do.',
  examples: [
    {
      repo: 'acme-raw-content',
      branch: 'staging',
      message: 'Update about page',
      author: EXAMPLE_IDENTITY,
      actions: [{ action: 'update', path: 'content/about.md', content: '# About us\n', encoding: 'text' }],
      idempotencyKey: 'cms:publish:2f9c1e',
    },
  ],
});

/** CommitWorkflow params after parsing (defaults applied). */
export type CommitWorkflowParams = z.output<typeof CommitWorkflowParams>;

/** The workflow wrote the commit. */
export const CommitStepCommitted = z
  .object({
    status: z.literal('committed').describe('The workflow wrote a new commit and moved the branch to it.'),
    sha: Sha.describe('Id of the commit written.'),
  })
  .strict()
  .meta({
    id: 'CommitStepCommitted',
    title: 'commit step: committed',
    description: "The CommitWorkflow's commit step wrote the commit. Carries the commit id only.",
    examples: [{ status: 'committed', sha: EXAMPLE_SHA_B }],
  });

/** A commit with the same idempotency key was already on the branch. */
export const CommitStepReplayed = z
  .object({
    status: z
      .literal('replayed')
      .describe(
        'A commit carrying the same idempotency key was already in the branch history (an earlier attempt, or a step that ran before a crash); nothing was written.',
      ),
    sha: Sha.describe('Id of the earlier commit carrying the key.'),
  })
  .strict()
  .meta({
    id: 'CommitStepReplayed',
    title: 'commit step: replayed',
    description:
      "The CommitWorkflow's commit step found the commit already written, so a replayed step never commits twice.",
    examples: [{ status: 'replayed', sha: EXAMPLE_SHA_B }],
  });

/** The actions changed nothing. */
export const CommitStepNoop = z
  .object({
    status: z.literal('noop').describe('The actions left the tree unchanged; nothing was written.'),
    head: Sha.nullable().describe('The branch head, unchanged; null when the branch does not exist.'),
  })
  .strict()
  .meta({
    id: 'CommitStepNoop',
    title: 'commit step: no-op',
    description: "The CommitWorkflow's commit step applied the actions to the head and nothing changed.",
    examples: [{ status: 'noop', head: EXAMPLE_SHA_A }],
  });

/**
 * What the CommitWorkflow's commit step stores and the instance returns. Ids and a status only:
 * never file content, a message or a credential, because step results are persisted by the
 * Workflows engine and shown in its dashboard.
 */
export const CommitStepResult = z
  .discriminatedUnion('status', [CommitStepCommitted, CommitStepReplayed, CommitStepNoop])
  .meta({
    id: 'CommitStepResult',
    title: 'CommitWorkflow result',
    description:
      "What the CommitWorkflow's commit step stores and the instance returns, discriminated by `status`: commit ids only, never file content or a credential.",
    examples: [{ status: 'committed', sha: EXAMPLE_SHA_B }],
  });

/** A CommitWorkflow result, inferred from {@link CommitStepResult}. */
export type CommitStepResult = z.infer<typeof CommitStepResult>;
