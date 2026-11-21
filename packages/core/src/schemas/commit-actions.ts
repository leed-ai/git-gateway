// SPDX-License-Identifier: Apache-2.0
import { CommitAction } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { GitObject } from './git-object.ts';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EXAMPLE_TREE = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** Input of applyCommitActions. */
export const ApplyActionsInput = z
  .object({
    tree: Sha.nullable().describe(
      "Id of the root tree the actions apply to (the head commit's tree); null for a branch with no commits yet, which starts from an empty tree.",
    ),
    actions: z
      .array(CommitAction)
      .min(1)
      .max(1000)
      .describe('Commit actions to apply in order, each to the result of the one before; 1–1000.'),
  })
  .strict()
  .meta({
    id: 'ApplyActionsInput',
    title: 'applyCommitActions input',
    description: 'A root tree and the commit actions to apply to it with GitLab Commits API semantics.',
    examples: [
      {
        tree: EMPTY_TREE,
        actions: [{ action: 'create', path: 'content/about.md', content: '# About\n', encoding: 'text' }],
      },
    ],
  });

/** Input of applyCommitActions, as accepted (defaults optional). */
export type ApplyActionsInput = z.input<typeof ApplyActionsInput>;

/** The actions changed the tree. */
export const ActionsChanged = z
  .object({
    status: z.literal('changed').describe('The actions produced a different tree.'),
    tree: Sha.describe('Id of the new root tree.'),
    objects: z
      .array(GitObject)
      .describe(
        'Every object the new tree needs that the base did not have: new blobs the final tree references, then new trees deepest first.',
      ),
  })
  .strict()
  .meta({
    id: 'ActionsChanged',
    title: 'Actions: changed',
    description: 'The actions produced a new tree; `objects` is what must be pushed along with the commit.',
    examples: [{ status: 'changed', tree: EXAMPLE_TREE, objects: [] }],
  });

/** The actions left the tree as it was. */
export const ActionsNoop = z
  .object({
    status: z.literal('noop').describe('The resulting tree equals the base tree.'),
    tree: Sha.describe('Id of the unchanged root tree (the empty tree when the base was null).'),
  })
  .strict()
  .meta({
    id: 'ActionsNoop',
    title: 'Actions: no-op',
    description:
      'The actions were valid but the resulting tree equals the base (e.g. an update writing the same content), so there is nothing to commit.',
    examples: [{ status: 'noop', tree: EMPTY_TREE }],
  });

/** The outcome of applying commit actions. */
export const ActionsResult = z.discriminatedUnion('status', [ActionsChanged, ActionsNoop]).meta({
  id: 'ActionsResult',
  title: 'Actions result',
  description: 'The outcome of applyCommitActions, discriminated by `status`.',
  examples: [{ status: 'noop', tree: EMPTY_TREE }],
});

/** The outcome of applying commit actions, inferred from {@link ActionsResult}. */
export type ActionsResult = z.infer<typeof ActionsResult>;
