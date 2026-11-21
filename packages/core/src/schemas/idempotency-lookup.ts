// SPDX-License-Identifier: Apache-2.0
import { IdempotencyConfig } from '@leed-ai/git-gateway-contract/schemas/gateway-config';
import { Timestamp } from '@leed-ai/git-gateway-contract/schemas/identity';
import { IdempotencyKey } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

/** Input of findIdempotentCommit. */
export const IdempotencyLookupInput = z
  .object({
    head: Sha.describe('Head commit of the branch to search, newest end of the window.'),
    key: IdempotencyKey.describe('The idempotency key of the write being attempted.'),
    window: IdempotencyConfig.describe(
      'How far back to look: at most `maxCommits` commits, none committed more than `maxAgeSeconds` before `now`.',
    ),
    now: Timestamp.describe('The current time, which the age bound is measured from.'),
  })
  .strict()
  .meta({
    id: 'IdempotencyLookupInput',
    title: 'Idempotency lookup',
    description:
      'Where and how far back to search a branch for a commit carrying a "Gateway-Idempotency-Key:" trailer with a given key.',
    examples: [
      {
        head: '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a',
        key: 'cms:publish:2f9c1e',
        window: { maxCommits: 200, maxAgeSeconds: 604_800 },
        now: '2026-11-20T09:30:00.000Z',
      },
    ],
  });

/** An idempotency lookup, as accepted (window defaults optional). */
export type IdempotencyLookupInput = z.input<typeof IdempotencyLookupInput>;
