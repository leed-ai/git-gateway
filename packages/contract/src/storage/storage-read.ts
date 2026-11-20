// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { BranchName, FullRefName } from '../schemas/names.ts';

/** A ref a storage backend resolves. */
export const StorageRef = z
  .union([
    FullRefName.describe(
      'A fully qualified ref, "refs/heads/<branch>" or "refs/tags/<tag>", resolved exactly.',
    ),
    BranchName.describe('A short branch name, resolved as "refs/heads/<name>".'),
  ])
  .meta({
    id: 'StorageRef',
    title: 'Storage ref',
    description:
      'A ref StorageBackend.resolveRef() resolves: a fully qualified "refs/heads/…" or "refs/tags/…" ref, or a short branch name meaning "refs/heads/<name>".',
    examples: ['main', 'refs/heads/staging', 'refs/tags/v1.0.0'],
  });

/** A ref a backend resolves, inferred from {@link StorageRef}. */
export type StorageRef = z.infer<typeof StorageRef>;

/** Paging of `StorageBackend.log`. */
export const StorageLogOptions = z
  .object({
    limit: z
      .int()
      .min(1)
      .max(1000)
      .describe('Most commits returned: 1–1000. Fewer come back when the history is shorter.'),
    offset: z.int().min(0).default(0).describe('Commits skipped from the newest before listing. Default 0.'),
  })
  .strict()
  .meta({
    id: 'StorageLogOptions',
    title: 'Storage log options',
    description:
      'Paging of StorageBackend.log(), which lists the first-parent chain from a revision, newest first: skip `offset` commits, then return up to `limit`.',
    examples: [{ limit: 50, offset: 0 }],
  });

/** Paging of `log` as accepted (defaults optional). */
export type StorageLogOptions = z.input<typeof StorageLogOptions>;
