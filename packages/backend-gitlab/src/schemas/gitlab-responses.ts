// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const SHA = /^[0-9a-f]{40}$/;
const EXAMPLE_SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const timestamp = z.iso.datetime({ offset: true });

/** A project from the GitLab Projects API. */
export const GitLabProject = z
  .object({
    id: z.int().positive().describe('Numeric project id.'),
    path: z.string().min(1).describe("The project's path segment, which is the repository name."),
    path_with_namespace: z.string().min(1).describe('Full path, "<namespace>/<path>".'),
    default_branch: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('The default branch; null or absent for an empty repository on some GitLab versions.'),
    created_at: timestamp.describe('When the project was created, ISO 8601.'),
    http_url_to_repo: z.url().describe('HTTPS clone URL of the repository, ending in ".git".'),
    marked_for_deletion_on: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Date the project is scheduled for deletion (delayed deletion); null or absent when it is not.',
      ),
  })
  .meta({
    id: 'GitLabProject',
    title: 'GitLab project',
    description: 'The fields of a GitLab project the backend uses; other fields are ignored.',
    examples: [
      {
        id: 1234,
        path: 'acme-raw-content',
        path_with_namespace: 'acme/sites/acme-raw-content',
        default_branch: 'main',
        created_at: '2026-11-20T09:30:00.000Z',
        http_url_to_repo: 'https://gitlab.com/acme/sites/acme-raw-content.git',
        marked_for_deletion_on: null,
      },
    ],
  });

/** A GitLab project, inferred from {@link GitLabProject}. */
export type GitLabProject = z.infer<typeof GitLabProject>;

/** A group from the GitLab Groups API. */
export const GitLabGroup = z
  .object({
    id: z.int().positive().describe('Numeric group id, used as namespace_id when creating projects.'),
    full_path: z.string().min(1).describe('Full path of the group.'),
  })
  .meta({
    id: 'GitLabGroup',
    title: 'GitLab group',
    description: 'The fields of a GitLab group the backend uses.',
    examples: [{ id: 42, full_path: 'acme/sites' }],
  });

/** A GitLab group, inferred from {@link GitLabGroup}. */
export type GitLabGroup = z.infer<typeof GitLabGroup>;

/** A branch or tag from the GitLab Branches or Tags API. */
export const GitLabRef = z
  .object({
    name: z.string().min(1).describe('Short branch or tag name.'),
    commit: z
      .object({
        id: z.string().regex(SHA).describe('Id of the commit the ref names (for a tag, the peeled commit).'),
      })
      .describe('The commit the ref points at.'),
  })
  .meta({
    id: 'GitLabRef',
    title: 'GitLab branch or tag',
    description: 'A branch or tag and the commit it names.',
    examples: [{ name: 'main', commit: { id: EXAMPLE_SHA } }],
  });

/** A GitLab branch or tag, inferred from {@link GitLabRef}. */
export type GitLabRef = z.infer<typeof GitLabRef>;

/** A commit from the GitLab Commits API, as listed. */
export const GitLabCommitSummary = z
  .object({
    id: z.string().regex(SHA).describe('The commit id.'),
    parent_ids: z
      .array(z.string().regex(SHA).describe('A parent commit id.'))
      .describe('Parent ids in order.'),
  })
  .meta({
    id: 'GitLabCommitSummary',
    title: 'GitLab commit summary',
    description:
      'The fields of a GitLab commit the backend uses to list history. GitLab does not report the tree id or exact message, so the commit objects themselves are fetched over git.',
    examples: [{ id: EXAMPLE_SHA, parent_ids: [] }],
  });

/** A listed GitLab commit, inferred from {@link GitLabCommitSummary}. */
export type GitLabCommitSummary = z.infer<typeof GitLabCommitSummary>;

/** The body of a GitLab API error response. */
export const GitLabErrorBody = z
  .object({
    message: z
      .union([
        z.string().describe('A plain message such as "404 Project Not Found".'),
        z
          .record(
            z.string().describe('The field that failed validation.'),
            z.array(z.string().describe('One failure.')).describe('What is wrong with it.'),
          )
          .describe('Validation failures by field, e.g. {"path": ["has already been taken"]}.'),
      ])
      .optional()
      .describe('The error message; absent when GitLab sent only "error".'),
    error: z.string().optional().describe('A short error code or message, e.g. "insufficient_scope".'),
  })
  .meta({
    id: 'GitLabErrorBody',
    title: 'GitLab error body',
    description: 'The JSON body of a GitLab API error.',
    examples: [{ message: '404 Project Not Found' }, { message: { path: ['has already been taken'] } }],
  });

/** A GitLab error body, inferred from {@link GitLabErrorBody}. */
export type GitLabErrorBody = z.infer<typeof GitLabErrorBody>;
