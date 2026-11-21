// SPDX-License-Identifier: Apache-2.0
import {
  EXAMPLE_SHA_A,
  EXAMPLE_SHA_B,
  EXAMPLE_TIMESTAMP,
} from '@leed-ai/git-gateway-contract/schemas/examples';
import { Timestamp } from '@leed-ai/git-gateway-contract/schemas/identity';
import { RepoName } from '@leed-ai/git-gateway-contract/schemas/names';
import { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { z } from 'zod';

/** A push the gateway accepted, as onPush hooks receive it. */
export const PushEvent = z
  .object({
    repo: RepoName.describe('Repository that was pushed to.'),
    updates: z
      .array(RefUpdate)
      .min(1)
      .max(1000)
      .describe(
        'Every ref the push moved, in the order the push named them; 1–1000. A created ref has an all-zero oldSha, a deleted ref an all-zero newSha.',
      ),
    pushedAt: Timestamp.describe('When the storage host accepted the push.'),
  })
  .strict()
  .meta({
    id: 'PushEvent',
    title: 'Push event',
    description:
      'A push the gateway accepted (through the smart-HTTP proxy or an RPC write), delivered to onPush hooks directly or through a Queue. Carries ref ids only: no content, no credential, no principal secret.',
    examples: [
      {
        repo: 'acme-raw-content',
        updates: [{ ref: 'refs/heads/main', oldSha: EXAMPLE_SHA_A, newSha: EXAMPLE_SHA_B }],
        pushedAt: EXAMPLE_TIMESTAMP,
      },
    ],
  });

/** A push event, inferred from {@link PushEvent}. */
export type PushEvent = z.infer<typeof PushEvent>;
