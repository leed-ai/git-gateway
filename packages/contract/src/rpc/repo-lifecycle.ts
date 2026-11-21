// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_TIMESTAMP } from '../schemas/examples.ts';
import { Timestamp } from '../schemas/identity.ts';
import { BranchName, RepoName } from '../schemas/names.ts';

/** Input of `createRepo`. */
export const CreateRepoInput = z
  .object({
    repo: RepoName.describe('Name of the repository to create.'),
    defaultBranch: BranchName.default('main').describe(
      'Branch HEAD names; it comes into being with the first commit to it. Default "main".',
    ),
  })
  .strict()
  .meta({
    id: 'CreateRepoInput',
    title: 'createRepo input',
    description:
      'Input of createRepo(): create an empty repository. Fails with repo_exists if the name is taken.',
    examples: [{ repo: 'acme-raw-content', defaultBranch: 'main' }],
  });

/** Input of `createRepo` as accepted (defaults optional). */
export type CreateRepoInput = z.input<typeof CreateRepoInput>;

/** A repository behind the gateway. */
export const RepoInfo = z
  .object({
    name: RepoName.describe('The repository name.'),
    defaultBranch: BranchName.describe('The branch HEAD names.'),
    createdAt: Timestamp.describe('When the repository was created.'),
    remoteUrl: z.url().describe('Clone URL of the repository on the gateway: <publicBaseUrl>/<name>.git.'),
  })
  .strict()
  .meta({
    id: 'RepoInfo',
    title: 'Repository',
    description: 'A repository behind the gateway.',
    examples: [
      {
        name: 'acme-raw-content',
        defaultBranch: 'main',
        createdAt: EXAMPLE_TIMESTAMP,
        remoteUrl: 'https://git.example.com/acme-raw-content.git',
      },
    ],
  });

/** A repository, inferred from {@link RepoInfo}. */
export type RepoInfo = z.infer<typeof RepoInfo>;

/** Output of `createRepo`: the new repository. */
export const CreateRepoOutput = RepoInfo.meta({
  id: 'CreateRepoOutput',
  title: 'createRepo output',
  description: 'Output of createRepo(): the repository created, empty (no branches until the first commit).',
  examples: [
    {
      name: 'acme-raw-content',
      defaultBranch: 'main',
      createdAt: EXAMPLE_TIMESTAMP,
      remoteUrl: 'https://git.example.com/acme-raw-content.git',
    },
  ],
});

/** Output of `createRepo`, inferred from {@link CreateRepoOutput}. */
export type CreateRepoOutput = z.infer<typeof CreateRepoOutput>;

/** Input of `deleteRepo`. */
export const DeleteRepoInput = z
  .object({
    repo: RepoName.describe('Name of the repository to delete, with all its branches and history.'),
  })
  .strict()
  .meta({
    id: 'DeleteRepoInput',
    title: 'deleteRepo input',
    description:
      'Input of deleteRepo(): permanently delete a repository. Deleting a missing repository is not an error.',
    examples: [{ repo: 'acme-raw-content' }],
  });

/** Input of `deleteRepo`, inferred from {@link DeleteRepoInput}. */
export type DeleteRepoInput = z.input<typeof DeleteRepoInput>;

/** Output of `deleteRepo`. */
export const DeleteRepoOutput = z
  .object({
    deleted: z.boolean().describe('true when a repository was deleted; false when none had that name.'),
  })
  .strict()
  .meta({
    id: 'DeleteRepoOutput',
    title: 'deleteRepo output',
    description: 'Output of deleteRepo().',
    examples: [{ deleted: true }],
  });

/** Output of `deleteRepo`, inferred from {@link DeleteRepoOutput}. */
export type DeleteRepoOutput = z.infer<typeof DeleteRepoOutput>;
