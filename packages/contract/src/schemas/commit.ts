// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_COMMIT } from './examples.ts';
import { IdempotencyKey } from './names.ts';
import { Sha } from './sha.ts';
import { Signature } from './identity.ts';

/** A commit as stored in a repository. */
export const Commit = z
  .object({
    sha: Sha.describe('Id of this commit.'),
    tree: Sha.describe('Id of the root tree this commit records.'),
    parents: z
      .array(Sha.describe('Id of a parent commit.'))
      .max(2)
      .describe(
        'Parent commit ids in order: empty for a root commit, one for an ordinary commit, two for a merge (the branch merged into first).',
      ),
    author: Signature.describe('Who wrote the change, and when.'),
    committer: Signature.describe(
      'Who recorded the commit, and when; equals the author unless one was given.',
    ),
    message: z
      .string()
      .min(1)
      .describe(
        'Full commit message as stored, including any "Gateway-Idempotency-Key:" trailer the gateway appended.',
      ),
    idempotencyKey: IdempotencyKey.nullable().describe(
      'The key from the message\'s "Gateway-Idempotency-Key:" trailer, or null when the commit has none.',
    ),
  })
  .strict()
  .meta({
    id: 'Commit',
    title: 'Commit',
    description: 'A commit as stored in a repository, with its message trailer parsed out.',
    examples: [EXAMPLE_COMMIT],
  });

/** A stored commit, inferred from {@link Commit}. */
export type Commit = z.infer<typeof Commit>;
