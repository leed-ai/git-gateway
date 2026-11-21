// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { FullRefName } from './names.ts';
import { Sha } from './sha.ts';

/** One ref moved by a write: the command a receive-pack request carries. */
export const RefUpdate = z
  .object({
    ref: FullRefName.describe('The ref that moved, fully qualified (refs/heads/<branch>).'),
    oldSha: Sha.describe(
      'Id the ref pointed at before the update; the all-zero id when the update created the ref.',
    ),
    newSha: Sha.describe(
      'Id the ref points at after the update; the all-zero id when the update deleted the ref.',
    ),
  })
  .strict()
  .refine((update) => update.oldSha !== update.newSha, {
    message: 'an update must change the ref',
    path: ['newSha'],
  })
  .meta({
    id: 'RefUpdate',
    title: 'Ref update',
    description:
      'One ref moved by a write, in receive-pack command form: the ref, the id it named before and the id it names after. Creation and deletion use the all-zero id on the missing side.',
    examples: [
      {
        ref: 'refs/heads/main',
        oldSha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
        newSha: '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a',
      },
    ],
  });

/** A ref update, inferred from {@link RefUpdate}. */
export type RefUpdate = z.infer<typeof RefUpdate>;
