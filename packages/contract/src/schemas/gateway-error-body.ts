// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { BranchName, FilePath, RepoName, Revision } from './names.ts';
import { Sha } from './sha.ts';

const message = z.string().min(1).describe('Human-readable explanation, safe to show to an end user.');
const repo = RepoName.describe('The repository the call named.');

/** Builds one error variant: a code literal, a message and typed details. */
function variant<const Code extends string, Shape extends z.ZodRawShape>(
  code: Code,
  meaning: string,
  details: Shape,
  example: { message: string; details: z.input<z.ZodObject<Shape>> },
) {
  return z
    .object({
      code: z.literal(code).describe(meaning),
      message,
      details: z.object(details).strict().describe(`Machine-readable facts about the ${code} error.`),
    })
    .strict()
    .meta({
      id: `GatewayError.${code}`,
      title: `${code} error`,
      description: meaning,
      examples: [{ code, ...example }],
    });
}

const PATH_EXAMPLE = { path: 'content/about.md' };
const SHA_A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const SHA_B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** The input failed schema validation. */
export const InvalidInputError = variant(
  'invalid_input',
  'The call input failed schema validation; nothing was read or written.',
  {
    issues: z
      .array(
        z
          .object({
            path: z
              .string()
              .describe('Dot-separated location of the bad value in the input; empty for the root.'),
            message: z.string().min(1).describe('What is wrong with the value.'),
          })
          .strict()
          .describe('One validation failure.'),
      )
      .min(1)
      .describe('Every validation failure found.'),
  },
  { message: 'Invalid input', details: { issues: [{ path: 'branch', message: 'Required' }] } },
);

/** The named repository does not exist. */
export const RepoNotFoundError = variant(
  'repo_not_found',
  'The named repository does not exist.',
  { repo },
  { message: 'Repository not found', details: { repo: 'acme' } },
);

/** A repository with that name already exists. */
export const RepoExistsError = variant(
  'repo_exists',
  'createRepo named a repository that already exists; it is left unchanged.',
  { repo },
  { message: 'Repository already exists', details: { repo: 'acme' } },
);

/** The named branch or commit does not exist. */
export const RefNotFoundError = variant(
  'ref_not_found',
  'A branch or commit the call named does not exist in the repository.',
  { ref: Revision.describe('The branch name or commit id that was not found.') },
  { message: 'Branch not found: staging', details: { ref: 'staging' } },
);

/** A create or move target already exists. */
export const PathExistsError = variant(
  'path_exists',
  'A create, upsert or move action targeted a path that is already a file or a directory.',
  { path: FilePath.describe('The path that already exists.') },
  { message: 'File already exists', details: PATH_EXAMPLE },
);

/** An action needed a file that does not exist. */
export const PathNotFoundError = variant(
  'path_not_found',
  'An update, delete, move or chmod action named a path that is not a file.',
  { path: FilePath.describe('The path that is not a file.') },
  { message: 'File not found', details: PATH_EXAMPLE },
);

/** A parent of the target path is a file. */
export const PathConflictError = variant(
  'path_conflict',
  'An action would place a file beneath a path that is itself a file.',
  {
    path: FilePath.describe('The path the action targeted.'),
    conflictingPath: FilePath.describe('The parent of `path` that is a file.'),
  },
  { message: 'A parent of the path is a file', details: { path: 'a/b.md', conflictingPath: 'a' } },
);

/** The branch head is not the head the caller expected. */
export const StaleHeadError = variant(
  'stale_head',
  'The branch head is not the head the caller expected; nothing was written. Re-read and retry.',
  {
    branch: BranchName.describe('The branch the write targeted.'),
    expectedHead: Sha.nullable().describe('The head the caller expected; null when it expected no branch.'),
    actualHead: Sha.nullable().describe('The current head; null when the branch does not exist.'),
  },
  { message: 'Branch head moved', details: { branch: 'main', expectedHead: SHA_A, actualHead: SHA_B } },
);

/** promote named a commit that is not the head of the source branch. */
export const NotHeadOfSourceError = variant(
  'not_head_of_source',
  'promote named a commit that is not the current head of the source branch; nothing moved.',
  {
    from: BranchName.describe('The source branch.'),
    sha: Sha.describe('The commit the caller asked to promote.'),
    head: Sha.describe('The current head of the source branch.'),
  },
  { message: 'Commit is not the head of staging', details: { from: 'staging', sha: SHA_A, head: SHA_B } },
);

/** promote would not be a fast-forward. */
export const NotFastForwardError = variant(
  'not_fast_forward',
  'promote named a commit that does not contain the head of the target branch; nothing moved.',
  {
    into: BranchName.describe('The target branch.'),
    sha: Sha.describe('The commit the caller asked to promote.'),
    head: Sha.describe('The current head of the target branch, which `sha` does not contain.'),
  },
  { message: 'Not a fast-forward', details: { into: 'main', sha: SHA_A, head: SHA_B } },
);

/** syncBranch found no common ancestor. */
export const UnrelatedHistoriesError = variant(
  'unrelated_histories',
  'syncBranch found no common ancestor between the branches, so there is nothing to merge against.',
  {
    from: BranchName.describe('The branch being merged in.'),
    into: BranchName.describe('The branch being brought up to date.'),
  },
  { message: 'Refusing to merge unrelated histories', details: { from: 'main', into: 'staging' } },
);

/** The storage backend failed. */
export const StorageUnavailableError = variant(
  'storage_unavailable',
  'The storage backend failed or timed out; the call may be retried with the same input.',
  { retryable: z.literal(true).describe('Always true: the same call may succeed later.') },
  { message: 'Storage backend unavailable', details: { retryable: true } },
);

/** Every error a gateway call can report, discriminated by `code`. */
export const GatewayErrorBody = z
  .discriminatedUnion('code', [
    InvalidInputError,
    RepoNotFoundError,
    RepoExistsError,
    RefNotFoundError,
    PathExistsError,
    PathNotFoundError,
    PathConflictError,
    StaleHeadError,
    NotHeadOfSourceError,
    NotFastForwardError,
    UnrelatedHistoriesError,
    StorageUnavailableError,
  ])
  .meta({
    id: 'GatewayErrorBody',
    title: 'Gateway error',
    description:
      'Every error a gateway call can report, discriminated by `code`, with a message and typed details. Thrown as a GatewayError whose `body` holds it.',
    examples: [{ code: 'repo_not_found', message: 'Repository not found', details: { repo: 'acme' } }],
  });

/** A gateway error body, inferred from {@link GatewayErrorBody}. */
export type GatewayErrorBody = z.infer<typeof GatewayErrorBody>;

/** The code of every gateway error; the same set as the `code` branches of {@link GatewayErrorBody}. */
export const GatewayErrorCode = z
  .enum([
    'invalid_input',
    'repo_not_found',
    'repo_exists',
    'ref_not_found',
    'path_exists',
    'path_not_found',
    'path_conflict',
    'stale_head',
    'not_head_of_source',
    'not_fast_forward',
    'unrelated_histories',
    'storage_unavailable',
  ])
  .meta({
    id: 'GatewayErrorCode',
    title: 'Gateway error code',
    description: 'The machine-readable code of a gateway error.',
    enumDescriptions: {
      invalid_input: 'The input failed schema validation.',
      repo_not_found: 'The named repository does not exist.',
      repo_exists: 'createRepo named an existing repository.',
      ref_not_found: 'A named branch or commit does not exist.',
      path_exists: 'A create, upsert or move target already exists.',
      path_not_found: 'An action needed a file that does not exist.',
      path_conflict: 'A parent of the target path is a file.',
      stale_head: 'The branch head is not the one the caller expected.',
      not_head_of_source: 'promote named a commit that is not the source head.',
      not_fast_forward: 'promote would not be a fast-forward.',
      unrelated_histories: 'syncBranch found no common ancestor.',
      storage_unavailable: 'The storage backend failed; retry later.',
    },
    examples: ['stale_head'],
  });

/** The code of a gateway error, inferred from {@link GatewayErrorCode}. */
export type GatewayErrorCode = z.infer<typeof GatewayErrorCode>;
