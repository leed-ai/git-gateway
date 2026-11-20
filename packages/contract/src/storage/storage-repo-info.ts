// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_TIMESTAMP } from '../schemas/examples.ts';
import { Timestamp } from '../schemas/identity.ts';
import { BranchName, RepoName } from '../schemas/names.ts';

/** Options of `StorageBackend.createRepo`. */
export const CreateStorageRepoOptions = z
  .object({
    defaultBranch: BranchName.default('main').describe(
      'Branch the new repository\'s HEAD names. It holds no commits until the first push to it. Default "main".',
    ),
  })
  .strict()
  .meta({
    id: 'CreateStorageRepoOptions',
    title: 'Storage createRepo options',
    description:
      'Options of StorageBackend.createRepo(): how the empty repository is set up on the storage host.',
    examples: [{ defaultBranch: 'main' }],
  });

/** Options of `StorageBackend.createRepo` as accepted (defaults optional). */
export type CreateStorageRepoOptions = z.input<typeof CreateStorageRepoOptions>;

/** A repository as the storage host describes it. */
export const StorageRepoInfo = z
  .object({
    name: RepoName.describe('The repository name, the same name the gateway serves it under.'),
    defaultBranch: BranchName.describe("The branch the repository's HEAD names on the storage host."),
    createdAt: Timestamp.nullable().describe(
      'When the storage host created the repository, as an ISO 8601 UTC timestamp; null when the host does not report it.',
    ),
  })
  .strict()
  .meta({
    id: 'StorageRepoInfo',
    title: 'Storage repository',
    description:
      'A repository as a StorageBackend reports it: name, default branch and creation time. Carries no host URL or credential; those come only from gitRemote().',
    examples: [{ name: 'acme-raw-content', defaultBranch: 'main', createdAt: EXAMPLE_TIMESTAMP }],
  });

/** A repository on the storage host, inferred from {@link StorageRepoInfo}. */
export type StorageRepoInfo = z.infer<typeof StorageRepoInfo>;
