// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Commit } from '../schemas/commit.ts';
import { EXAMPLE_COMMIT } from '../schemas/examples.ts';
import { Timestamp } from '../schemas/identity.ts';
import { RepoName, Revision } from '../schemas/names.ts';

/** Input of `log`. */
export const LogInput = z
  .object({
    repo: RepoName.describe('Repository to read from.'),
    ref: Revision.describe('Branch name or commit id whose history is listed, starting at that commit.'),
    limit: z.int().min(1).max(500).default(50).describe('Most commits returned; 1–500, default 50.'),
    offset: z.int().min(0).default(0).describe('Commits skipped from the newest before listing; default 0.'),
    since: Timestamp.optional().describe(
      'When given, only commits whose committer date is at or after this time are listed. Absent: no lower bound.',
    ),
  })
  .strict()
  .meta({
    id: 'LogInput',
    title: 'log input',
    description:
      'Input of log(): the history reachable from a branch or commit, newest committer date first (children always before their parents). Fails with ref_not_found if the ref is missing.',
    examples: [
      { repo: 'acme-raw-content', ref: 'main', limit: 20, offset: 0, since: '2026-11-01T00:00:00.000Z' },
    ],
  });

/** Input of `log` as accepted (defaults optional). */
export type LogInput = z.input<typeof LogInput>;

/** Output of `log`. */
export const LogOutput = z
  .object({
    commits: z
      .array(Commit)
      .describe('The page of history, newest committer date first; empty when nothing matches.'),
    hasMore: z.boolean().describe('true when further matching commits exist beyond this page.'),
  })
  .strict()
  .meta({
    id: 'LogOutput',
    title: 'log output',
    description: 'Output of log(): one page of history.',
    examples: [{ commits: [EXAMPLE_COMMIT], hasMore: false }],
  });

/** Output of `log`, inferred from {@link LogOutput}. */
export type LogOutput = z.infer<typeof LogOutput>;
